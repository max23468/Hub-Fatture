import { z } from "zod";

const schema = z
  .object({
    ADMIN_BOOTSTRAP_TOKEN: z.string().min(32),
    APP_BASE_URL: z.url(),
    APP_ENV: z.enum(["development", "production", "test"]).default("development"),
    CREDENTIALS_ENCRYPTION_KEY: z
      .string()
      .transform((value) => value.trim() || undefined)
      .pipe(
        z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .optional(),
      )
      .optional(),
    DATABASE_URL: z.string().min(1),
    EBAY_ACCOUNT_REFERENCE: z.string().default("botCF"),
    EBAY_CLIENT_ID: z.string().optional(),
    EBAY_CLIENT_SECRET: z.string().optional(),
    EBAY_ENVIRONMENT: z.enum(["sandbox", "production"]).default("production"),
    EBAY_RUNAME: z.string().optional(),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
    SHOPIFY_API_KEY: z.string().optional(),
    SHOPIFY_API_SECRET: z.string().optional(),
    SHOPIFY_SHOP: z.string().optional(),
  })
  .refine(
    ({ APP_BASE_URL, APP_ENV }) =>
      APP_ENV !== "production" || new URL(APP_BASE_URL).protocol === "https:",
    { message: "APP_BASE_URL deve usare HTTPS in Production", path: ["APP_BASE_URL"] },
  );

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  return schema.parse(environment);
}

export function getConfig(): Config {
  return (cached ??= parseConfig(process.env));
}
