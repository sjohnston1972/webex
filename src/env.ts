export type Env = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  PUSH_QUEUE: Queue<{ jobId: string }>;
  AI: Ai;
  ENC_KEY: string;
  PIN_CODE: string;
  WEBEX_CLIENT_ID: string;
  WEBEX_SECRET: string;
  WEBEX_REDIRECT_URL: string;
};

export type AppContext = { Bindings: Env };
