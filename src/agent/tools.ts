import type Anthropic from "@anthropic-ai/sdk";
import type { OlistClient } from "../olist/client.js";
import type { ShopifyClient, ShopifyOrder } from "../shopify/client.js";
import { emailsMatch, normalizeCpf, phonesMatch } from "./policy.js";

export type MotivoEscalonamento =
  | "reclamacao"
  | "troca_devolucao_estorno"
  | "produto_avariado"
  | "negociacao_desconto"
  | "pedido_explicito_humano"
  | "dado_sensivel_pagamento"
  | "suspeita_menor_idade"
  | "fora_do_escopo"
  | "baixa_confianca"
  | "falha_tecnica";

export interface AgentOutcome {
  escalate: { motivo: MotivoEscalonamento; resumo: string } | null;
  stayQuiet: { motivo: string } | null;
  toolsUsed: string[];
}

export interface ToolContext {
  shopify: ShopifyClient;
  olist: OlistClient | null;
  contact: { name?: string | null; phone?: string | null; email?: string | null };
  outcome: AgentOutcome;
}

// ---------------------------------------------------------------- definições --

/**
 * A ordem e o conteúdo deste array precisam ser estáveis: o bloco de tools é
 * renderizado antes do system prompt e qualquer mudança invalida o cache.
 */
export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "buscar_pedido",
    description:
      "Consulta um pedido do cliente na loja (Shopify) e, se necessário, no ERP (Olist Tiny). " +
      "Use sempre que o cliente perguntar sobre um pedido específico: status, o que foi comprado, valor ou pagamento. " +
      "A ferramenta valida automaticamente se o pedido pertence a este contato do WhatsApp; se não pertencer, ela não devolve os dados.",
    input_schema: {
      type: "object",
      properties: {
        numero_pedido: {
          type: "string",
          description: "Número do pedido informado pelo cliente, com ou sem #. Ex.: '1234' ou '#1234'.",
        },
        email: {
          type: "string",
          description: "E-mail que o cliente informou nesta conversa como sendo o da compra.",
        },
        cpf: {
          type: "string",
          description: "CPF que o cliente informou nesta conversa, só dígitos ou formatado.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "rastrear_entrega",
    description:
      "Retorna o status de envio, a transportadora e o código de rastreio de um pedido já identificado. " +
      "Use depois de localizar o pedido com buscar_pedido, quando o cliente perguntar 'onde está' ou 'quando chega'.",
    input_schema: {
      type: "object",
      properties: {
        numero_pedido: { type: "string", description: "Número do pedido já confirmado nesta conversa." },
      },
      required: ["numero_pedido"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_produto",
    description:
      "Busca produtos no catálogo da loja por nome, tipo, uva ou característica. " +
      "Retorna nome, preço, disponibilidade e link. Use para recomendação, preço e dúvida sobre rótulo.",
    input_schema: {
      type: "object",
      properties: {
        termo: {
          type: "string",
          description: "Termo de busca. Ex.: 'espumante brut', 'moscatel', 'Chandon', 'vinho tinto merlot'.",
        },
      },
      required: ["termo"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_estoque",
    description:
      "Consulta o saldo real de estoque de um produto no ERP (Olist Tiny). " +
      "Use quando o cliente quiser comprar quantidade grande ou quando a disponibilidade do site parecer duvidosa.",
    input_schema: {
      type: "object",
      properties: {
        termo_ou_sku: { type: "string", description: "Nome do produto ou SKU." },
      },
      required: ["termo_ou_sku"],
      additionalProperties: false,
    },
  },
  {
    name: "escalar_para_humano",
    description:
      "Transfere a conversa para um atendente humano. Use assim que identificar qualquer situação da lista de escalonamento. " +
      "Depois de chamar esta ferramenta, não continue tentando resolver o problema sozinho.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: [
            "reclamacao",
            "troca_devolucao_estorno",
            "produto_avariado",
            "negociacao_desconto",
            "pedido_explicito_humano",
            "dado_sensivel_pagamento",
            "suspeita_menor_idade",
            "fora_do_escopo",
            "baixa_confianca",
            "falha_tecnica",
          ],
          description: "Categoria do motivo do escalonamento.",
        },
        resumo: {
          type: "string",
          description:
            "Resumo objetivo para o atendente humano: quem é o cliente, o que ele quer, o que já foi consultado e o que falta decidir. 2 a 4 frases.",
        },
      },
      required: ["motivo", "resumo"],
      additionalProperties: false,
    },
  },
  {
    name: "nao_responder",
    description:
      "Encerra sem enviar nada ao cliente. Use apenas para spam, propaganda, engano de número ou mensagem sem conteúdo.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por que nenhuma resposta é adequada." },
      },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
];

// ------------------------------------------------------------- titularidade --

export interface OwnershipInput {
  orderPhones: Array<string | null | undefined>;
  orderEmails: Array<string | null | undefined>;
  contactPhone: string | null | undefined;
  contactEmail: string | null | undefined;
  providedEmail?: string;
}

/**
 * Decide se podemos mostrar os dados de um pedido a quem está do outro lado.
 *
 * Um número de WhatsApp não é prova de identidade forte, mas é o que temos, e é
 * o mesmo critério que a loja usa no balcão. Aceitamos duas provas:
 *   1. o telefone do pedido bate com o número desta conversa; ou
 *   2. o cliente informou, de memória, o e-mail usado na compra.
 * Sem nenhuma das duas, não devolvemos dado nenhum.
 */
export function isOrderOwnedByContact(input: OwnershipInput): boolean {
  const phoneOk = input.orderPhones.some((p) => phonesMatch(p, input.contactPhone));
  if (phoneOk) return true;

  const emailOk = input.orderEmails.some(
    (e) => emailsMatch(e, input.contactEmail) || (input.providedEmail ? emailsMatch(e, input.providedEmail) : false),
  );
  return emailOk;
}

function shopifyOwnership(order: ShopifyOrder, ctx: ToolContext, providedEmail?: string): boolean {
  return isOrderOwnedByContact({
    orderPhones: [order.phone, order.customer?.phone, order.shippingAddress?.phone],
    orderEmails: [order.email, order.customer?.email],
    contactPhone: ctx.contact.phone,
    contactEmail: ctx.contact.email,
    providedEmail,
  });
}

// ------------------------------------------------------------------ formato --

const STATUS_PAGAMENTO: Record<string, string> = {
  PAID: "pago",
  PENDING: "aguardando pagamento",
  PARTIALLY_PAID: "parcialmente pago",
  REFUNDED: "reembolsado",
  PARTIALLY_REFUNDED: "parcialmente reembolsado",
  VOIDED: "cancelado",
  AUTHORIZED: "autorizado, ainda não capturado",
  EXPIRED: "pagamento expirado",
};

const STATUS_ENVIO: Record<string, string> = {
  FULFILLED: "enviado",
  UNFULFILLED: "ainda não enviado",
  PARTIALLY_FULFILLED: "parcialmente enviado",
  IN_PROGRESS: "em separação",
  SCHEDULED: "envio agendado",
  ON_HOLD: "retido",
  RESTOCKED: "itens devolvidos ao estoque",
};

function traduzir(map: Record<string, string>, value: string | null): string {
  if (!value) return "desconhecido";
  return map[value] ?? value.toLowerCase();
}

function resumirPedido(order: ShopifyOrder) {
  return {
    numero: order.name,
    data: order.createdAt,
    cancelado: Boolean(order.cancelledAt),
    pagamento: traduzir(STATUS_PAGAMENTO, order.displayFinancialStatus),
    envio: traduzir(STATUS_ENVIO, order.displayFulfillmentStatus),
    valor_total: `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`,
    cliente: [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ") || null,
    destino: order.shippingAddress
      ? `${order.shippingAddress.city ?? "?"}/${order.shippingAddress.provinceCode ?? "?"}`
      : null,
    itens: order.lineItems.nodes.map((i) => ({ produto: i.title, quantidade: i.quantity, sku: i.sku })),
    rastreios: order.fulfillments.flatMap((f) =>
      f.trackingInfo.map((t) => ({
        transportadora: t.company,
        codigo: t.number,
        link: t.url,
        enviado_em: f.createdAt,
        previsao: f.estimatedDeliveryAt,
      })),
    ),
  };
}

// ---------------------------------------------------------------- execução --

/** Normaliza '#1234', '1234', 'pedido 1234' para '1234'. */
function limparNumeroPedido(value: string): string {
  const match = value.match(/\d{3,}/);
  return match ? match[0] : value.trim().replace(/^#/, "");
}

async function localizarPedidos(
  ctx: ToolContext,
  args: { numero_pedido?: string; email?: string; cpf?: string },
): Promise<ShopifyOrder[]> {
  if (args.numero_pedido) {
    const numero = limparNumeroPedido(args.numero_pedido);
    return ctx.shopify.searchOrders(`name:#${numero}`);
  }
  if (args.email) return ctx.shopify.searchOrders(`email:${args.email}`);
  if (ctx.contact.email) return ctx.shopify.searchOrders(`email:${ctx.contact.email}`);
  if (ctx.contact.phone) return ctx.shopify.searchOrders(`phone:${ctx.contact.phone}`);
  return [];
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<string> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  ctx.outcome.toolsUsed.push(name);

  switch (name) {
    case "escalar_para_humano": {
      const motivo = String(input.motivo ?? "baixa_confianca") as MotivoEscalonamento;
      const resumo = String(input.resumo ?? "").trim() || "Sem resumo fornecido pelo agente.";
      ctx.outcome.escalate = { motivo, resumo };
      return JSON.stringify({
        ok: true,
        mensagem:
          "Conversa marcada para atendimento humano. Avise o cliente de forma breve que você vai passar para a equipe e não prometa prazo de retorno.",
      });
    }

    case "nao_responder": {
      ctx.outcome.stayQuiet = { motivo: String(input.motivo ?? "sem motivo") };
      return JSON.stringify({ ok: true, mensagem: "Nenhuma resposta será enviada." });
    }

    case "buscar_pedido": {
      const args = {
        numero_pedido: input.numero_pedido ? String(input.numero_pedido) : undefined,
        email: input.email ? String(input.email) : undefined,
        cpf: input.cpf ? String(input.cpf) : undefined,
      };

      if (!args.numero_pedido && !args.email && !ctx.contact.email && !ctx.contact.phone) {
        return JSON.stringify({
          encontrado: false,
          motivo: "sem_identificador",
          instrucao: "Peça ao cliente o número do pedido ou o e-mail usado na compra.",
        });
      }

      const pedidos = await localizarPedidos(ctx, args);
      if (pedidos.length === 0) {
        // O ERP às vezes tem pedido que a loja não tem (venda por telefone,
        // marketplace). Tentamos o Olist antes de dizer que não existe.
        const doErp = await buscarNoOlist(ctx, args);
        if (doErp) return doErp;
        return JSON.stringify({
          encontrado: false,
          motivo: "nao_localizado",
          instrucao:
            "Nenhum pedido encontrado com esses dados. Peça o número do pedido e o e-mail usado na compra. Não afirme que o pedido não existe.",
        });
      }

      const autorizados = pedidos.filter((p) => shopifyOwnership(p, ctx, args.email));
      if (autorizados.length === 0) {
        return JSON.stringify({
          encontrado: true,
          autorizado: false,
          motivo: "titularidade_nao_confirmada",
          instrucao:
            "Existe um pedido com esse número, mas ele não está vinculado a este WhatsApp. NÃO revele nenhum dado dele. " +
            "Peça o e-mail usado na compra. Se o cliente informar e continuar sem bater, escale para um humano.",
        });
      }

      return JSON.stringify({ encontrado: true, autorizado: true, pedidos: autorizados.map(resumirPedido) });
    }

    case "rastrear_entrega": {
      const numero = limparNumeroPedido(String(input.numero_pedido ?? ""));
      if (!numero) {
        return JSON.stringify({ ok: false, instrucao: "Peça o número do pedido ao cliente." });
      }

      const pedidos = await ctx.shopify.searchOrders(`name:#${numero}`);
      const pedido = pedidos.find((p) => shopifyOwnership(p, ctx));
      if (!pedido) {
        return JSON.stringify({
          ok: false,
          motivo: "nao_localizado_ou_nao_autorizado",
          instrucao:
            "Não foi possível confirmar que este pedido é deste contato. Peça o e-mail da compra; sem confirmação, escale.",
        });
      }

      const resumo = resumirPedido(pedido);
      const doErp = await rastreioNoOlist(ctx, numero);
      return JSON.stringify({
        ok: true,
        numero: resumo.numero,
        envio: resumo.envio,
        rastreios_loja: resumo.rastreios,
        rastreio_erp: doErp,
        observacao:
          resumo.rastreios.length === 0 && !doErp
            ? "Ainda não há código de rastreio. Informe que o pedido ainda não foi despachado, sem prometer data."
            : null,
      });
    }

    case "buscar_produto": {
      const termo = String(input.termo ?? "").trim();
      if (!termo) return JSON.stringify({ encontrado: false, instrucao: "Pergunte o que o cliente procura." });

      const produtos = await ctx.shopify.searchProducts(termo);
      if (produtos.length === 0) {
        return JSON.stringify({
          encontrado: false,
          instrucao: "Nada no catálogo com esse termo. Ofereça ajuda para encontrar algo parecido, sem inventar rótulos.",
        });
      }
      return JSON.stringify({
        encontrado: true,
        produtos: produtos
          .filter((p) => p.status === "ACTIVE")
          .map((p) => ({
            nome: p.title,
            preco_a_partir_de: `${p.priceRangeV2.minVariantPrice.amount} ${p.priceRangeV2.minVariantPrice.currencyCode}`,
            disponivel: p.variants.nodes.some((v) => v.availableForSale),
            link: p.onlineStoreUrl,
            descricao: p.description,
            variacoes: p.variants.nodes.map((v) => ({
              nome: v.title,
              sku: v.sku,
              preco: v.price,
              disponivel: v.availableForSale,
            })),
          })),
      });
    }

    case "consultar_estoque": {
      const termo = String(input.termo_ou_sku ?? "").trim();
      if (!ctx.olist) {
        return JSON.stringify({
          ok: false,
          instrucao: "ERP indisponível nesta instalação. Use a disponibilidade do site (buscar_produto).",
        });
      }
      const produtos = await ctx.olist.buscarProdutos(termo);
      if (produtos.length === 0) {
        return JSON.stringify({ ok: false, instrucao: "Produto não encontrado no ERP. Não afirme indisponibilidade." });
      }
      const alvo = produtos[0]!;
      const estoque = await ctx.olist.obterEstoque(alvo.id);
      return JSON.stringify({
        ok: true,
        produto: alvo.descricao ?? termo,
        sku: alvo.sku,
        saldo: estoque.saldo ?? alvo.saldo ?? null,
        saldo_reservado: estoque.saldoReservado ?? null,
      });
    }

    default:
      return JSON.stringify({ erro: `Ferramenta desconhecida: ${name}` });
  }
}

// ------------------------------------------------------------------- Olist --

async function buscarNoOlist(
  ctx: ToolContext,
  args: { numero_pedido?: string; cpf?: string },
): Promise<string | null> {
  if (!ctx.olist || (!args.numero_pedido && !args.cpf)) return null;
  try {
    const pedidos = await ctx.olist.buscarPedidos({
      numero: args.numero_pedido ? limparNumeroPedido(args.numero_pedido) : undefined,
      cpfCnpj: args.cpf ? normalizeCpf(args.cpf) : undefined,
    });
    if (pedidos.length === 0) return null;

    const autorizados = pedidos.filter((p) =>
      isOrderOwnedByContact({
        orderPhones: [p.cliente?.fone],
        orderEmails: [p.cliente?.email],
        contactPhone: ctx.contact.phone,
        contactEmail: ctx.contact.email,
      }),
    );
    if (autorizados.length === 0) {
      return JSON.stringify({
        encontrado: true,
        autorizado: false,
        motivo: "titularidade_nao_confirmada",
        instrucao: "Não revele dados. Peça o e-mail da compra e, se não bater, escale.",
      });
    }
    return JSON.stringify({
      encontrado: true,
      autorizado: true,
      origem: "erp",
      pedidos: autorizados.map((p) => ({
        numero: p.numeroPedido ?? p.id,
        situacao: p.situacao,
        data: p.dataCriacao,
        previsao: p.dataPrevista,
        valor_total: p.valorTotal,
      })),
    });
  } catch {
    // Falha do ERP não pode derrubar o atendimento: o Shopify já respondeu.
    return null;
  }
}

async function rastreioNoOlist(ctx: ToolContext, numero: string): Promise<unknown | null> {
  if (!ctx.olist) return null;
  try {
    const pedidos = await ctx.olist.buscarPedidos({ numero });
    const primeiro = pedidos[0];
    if (!primeiro) return null;
    const detalhe = await ctx.olist.obterPedido(primeiro.id);
    return {
      situacao: detalhe.situacao,
      transportadora: detalhe.transportador?.nome ?? detalhe.transportador?.formaEnvio?.nome ?? null,
      codigo_rastreio: detalhe.transportador?.codigoRastreamento ?? null,
      link_rastreio: detalhe.transportador?.urlRastreamento ?? null,
      nota_fiscal: detalhe.notaFiscal?.numero ?? null,
    };
  } catch {
    return null;
  }
}
