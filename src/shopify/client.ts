import type { Config } from "../config.js";
import { HttpError, fetchJson } from "../util/http.js";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface ShopifyOrder {
  name: string;
  createdAt: string;
  email: string | null;
  phone: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customer: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null;
  shippingAddress: { city: string | null; provinceCode: string | null; zip: string | null; phone: string | null } | null;
  lineItems: { nodes: Array<{ title: string; quantity: number; sku: string | null }> };
  fulfillments: Array<{
    status: string | null;
    createdAt: string;
    estimatedDeliveryAt: string | null;
    trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
  }>;
}

export interface ShopifyProduct {
  title: string;
  handle: string;
  status: string;
  onlineStoreUrl: string | null;
  totalInventory: number | null;
  description: string | null;
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
  variants: { nodes: Array<{ title: string; sku: string | null; price: string; availableForSale: boolean; inventoryQuantity: number | null }> };
}

const ORDER_FIELDS = `
  name
  createdAt
  email
  phone
  cancelledAt
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName lastName email phone }
  shippingAddress { city provinceCode zip phone }
  lineItems(first: 25) { nodes { title quantity sku } }
  fulfillments(first: 10) {
    status
    createdAt
    estimatedDeliveryAt
    trackingInfo { company number url }
  }
`;

export class ShopifyClient {
  private readonly endpoint: string;

  constructor(private readonly cfg: Config) {
    const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.endpoint = `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}/graphql.json`;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = await fetchJson<GraphQLResponse<T>>(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.cfg.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (body.errors?.length) {
      throw new HttpError(400, this.endpoint, body.errors.map((e) => e.message).join("; "));
    }
    if (!body.data) throw new HttpError(500, this.endpoint, "resposta GraphQL sem data");
    return body.data;
  }

  /**
   * Busca pedidos por uma expressão de busca do Shopify. Exemplos aceitos pelo
   * Shopify: `name:#1234`, `email:cliente@x.com`, `phone:+5551999...`.
   */
  async searchOrders(searchQuery: string, limit = 5): Promise<ShopifyOrder[]> {
    const data = await this.graphql<{ orders: { nodes: ShopifyOrder[] } }>(
      `query BuscarPedidos($q: String!, $n: Int!) {
         orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) {
           nodes { ${ORDER_FIELDS} }
         }
       }`,
      { q: searchQuery, n: limit },
    );
    return data.orders.nodes;
  }

  async searchProducts(term: string, limit = 5): Promise<ShopifyProduct[]> {
    const data = await this.graphql<{ products: { nodes: ShopifyProduct[] } }>(
      `query BuscarProdutos($q: String!, $n: Int!) {
         products(first: $n, query: $q) {
           nodes {
             title
             handle
             status
             onlineStoreUrl
             totalInventory
             description(truncateAt: 600)
             priceRangeV2 { minVariantPrice { amount currencyCode } }
             variants(first: 10) { nodes { title sku price availableForSale inventoryQuantity } }
           }
         }
       }`,
      { q: term, n: limit },
    );
    return data.products.nodes;
  }
}
