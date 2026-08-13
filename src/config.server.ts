import { z } from "zod";

export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;

const schema = z
  .object({
    ADMIN_BOOTSTRAP_TOKEN: z.string().min(32),
    APP_BASE_URL: z.url(),
    APP_COMMIT_SHA: z.string().default("development"),
    APP_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_IMAGE_DIGEST: z.string().default("local"),
    APP_VERSION: z.string().default("0.0.0"),
    ARUBA_ACCOUNT_REFERENCE: z.string().trim().min(1).max(200).default("synthetic-aruba-account"),
    ARUBA_SUBMISSION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    BACKUP_RECEIPT_PATH: z.string().trim().min(1).optional(),
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
    DOCUMENT_STORAGE_ROOT: z.string().min(1).default("storage/documents"),
    EBAY_ACCOUNT_REFERENCE: z.string().default("botCF"),
    EBAY_CLIENT_ID: z.string().optional(),
    EBAY_CLIENT_SECRET: z.string().optional(),
    EBAY_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    EBAY_RUNAME: z.string().optional(),
    SMTP_FROM: z.email().max(256).default("contabilita@example.invalid"),
    SMTP_HOST: z.string().trim().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_TRANSPORT: z
      .enum(["SYNTHETIC", "EXISTING_SMTP", "OCI_EMAIL_DELIVERY"])
      .default("SYNTHETIC"),
    SMTP_USERNAME: z.string().trim().min(1).optional(),
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
    ({ APP_ENV, SMTP_HOST, SMTP_PASSWORD, SMTP_TRANSPORT, SMTP_USERNAME }) =>
      APP_ENV !== "production" ||
      (SMTP_TRANSPORT === "OCI_EMAIL_DELIVERY" &&
        SMTP_HOST === "smtp.email.eu-milan-1.oci.oraclecloud.com" &&
        Boolean(SMTP_USERNAME && SMTP_PASSWORD)),
    {
      message:
        "Il trasporto SMTP Production richiede OCI Email Delivery a Milano e credenziali complete",
      path: ["SMTP_TRANSPORT"],
    },
  )
  .refine(
    ({ APP_ENV, SMTP_FROM }) =>
      APP_ENV !== "production" || SMTP_FROM.toLowerCase().endsWith("@numisleo.it"),
    {
      message: "SMTP_FROM deve usare il dominio numisleo.it in Production",
      path: ["SMTP_FROM"],
    },
  )
  .refine(
    ({ APP_ENV, ARUBA_ACCOUNT_REFERENCE }) =>
      APP_ENV !== "production" || ARUBA_ACCOUNT_REFERENCE !== "synthetic-aruba-account",
    {
      message: "ARUBA_ACCOUNT_REFERENCE deve identificare l’account operativo in Production",
      path: ["ARUBA_ACCOUNT_REFERENCE"],
    },
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
    SMTP_HOST: environment.SMTP_HOST || undefined,
    SMTP_PASSWORD: environment.SMTP_PASSWORD || undefined,
    SMTP_USERNAME: environment.SMTP_USERNAME || undefined,
  });
}

export function getConfig(): Config {
  return (cached ??= parseConfig(process.env));
}
