declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: string;
      BOT_TOKEN: string;
      WEBSITE_URL: string;
      SUPPORT_USERNAME_TG: string;
      BOT_USERNAME: string;
      IS_WEBHOOK?: string;
      PORT_WEBHOOK?: string;
      DOMAINR_TOKEN?: string;
      PAYMENT_CRYSTALPAY_ID: string;
      PAYMENT_CRYSTALPAY_SECRET_ONE: string;
      PAYMENT_CRYSTALPAY_SECRET_TWO: string;
      VMM_EMAIL: string;
      VMM_PASSWORD: string;
      VMM_ENDPOINT_URL: string;
    }
  }
}
export {};
