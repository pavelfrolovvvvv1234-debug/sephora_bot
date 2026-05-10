import axios, { type AxiosInstance } from "axios";

interface ResponseCreatedInvoice {
  id: string;
  url: string;
  type: "purchase";
  rub_amount: string;
  expired_at?: string;
}

interface ResponseInvoiceInfo {
  error: boolean;
  errors: string[];
  id: string;
  url: string;
  state:
    | "notpayed"
    | "processing"
    | "wrongamount"
    | "failed"
    | "payed"
    | "unavailable";
  type: string;
  method: string | null;
  required_method: string | null;
  amount_currency: string;
  rub_amount: string;
  initial_amount: string;
  remaining_amount: string;
  balance_amount: string;
  commission_amount: string;
  description: string | null;
  redirect_url: string;
  callback_url: string | null;
  extra: string | null;
  created_at: string;
  expired_at: string;
  final_at: string | null;
}

export class CrystalPayClient {
  private endpoint: string = "https://api.crystalpay.io/v3/";
  private axiosClient: AxiosInstance;

  constructor(private login: string, private secretKey: string) {
    this.axiosClient = axios.create({
      baseURL: this.endpoint,
      headers: {
        "User-Agent": "SephoraHost/Bot 1.1",
      },
    });
  }

  async createInvoice(amount: number, orderId?: string): Promise<ResponseCreatedInvoice> {
    try {
      const redirectUrl =
        process.env["PAYMENT_CRYSTALPAY_REDIRECT_URL"] ||
        (process.env["BOT_USERNAME"]
          ? `https://t.me/@${process.env["BOT_USERNAME"]}/`
          : undefined);
      const callbackUrl = process.env["PAYMENT_CRYSTALPAY_CALLBACK_URL"];

      const payload: Record<string, unknown> = {
        auth_login: this.login,
        auth_secret: this.secretKey,
        amount,
        amount_currency: "USD",
        lifetime: 30,
        type: "purchase",
      };
      if (redirectUrl) {
        payload.redirect_url = redirectUrl;
      }
      if (callbackUrl) {
        payload.callback_url = callbackUrl;
      }
      if (orderId) {
        payload.extra = orderId;
      }

      const response = await this.axiosClient<ResponseCreatedInvoice>(
        "/invoice/create/",
        {
          method: "POST",
          data: payload,
        }
      );
      return response.data;
    } catch (err) {
      throw new Error("Failed Create");
    }
  }

  async getInvoice(id: string) {
    const response = await this.axiosClient<ResponseInvoiceInfo>(
      "/invoice/info/",
      {
        method: "POST",
        data: {
          auth_login: this.login,
          auth_secret: this.secretKey,
          id,
        },
      }
    );

    return response.data;
  }
}
