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
    EBAY_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
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
  )
  .refine(
    ({ APP_ENV, EBAY_ENVIRONMENT }) =>
      (APP_ENV === "production") === (EBAY_ENVIRONMENT === "production"),
    {
      message: "EBAY_ENVIRONMENT deve essere coerente con APP_ENV",
      path: ["EBAY_ENVIRONMENT"],
    },
  );

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  return schema.parse({
    ...environment,
    APP_BASE_URL: environment.APP_BASE_URL ?? environment.APP_URL ?? environment.HOST,
  });
}

export function getConfig(): Config {
  return (cached ??= parseConfig(process.env));
}
