import nodemailer from "nodemailer";

const smtpHost = process.env.SMTP_HOST;
const smtpPort = 587;

// Port 587 = STARTTLS
const smtpSecure = false;
const smtpRequireTLS = true;

console.log("========== EMAIL CONFIGURATION ==========");
console.log("SMTP_HOST:", smtpHost || "MISSING");
console.log("SMTP_PORT:", smtpPort);
console.log("SMTP_SECURE:", smtpSecure);
console.log("SMTP_REQUIRE_TLS:", smtpRequireTLS);
console.log("SMTP_USER:", process.env.SMTP_USER || "MISSING");
console.log("SMTP_PASS:", process.env.SMTP_PASS ? "SET" : "MISSING");

console.log(
  "FROM_EMAIL:",
  process.env.FROM_EMAIL || process.env.MAILERCLOUD_FROM_EMAIL || "MISSING",
);

console.log(
  "FROM_NAME:",
  process.env.FROM_NAME || process.env.MAILERCLOUD_FROM_NAME || "Fiona Loans",
);

console.log(
  "MAILERCLOUD_CAMPAIGN_ID:",
  process.env.MAILERCLOUD_CAMPAIGN_ID ? "SET" : "NOT SET",
);

console.log("==========================================");

/**
 * SMTP transporter
 *
 * Port 587:
 * - secure: false
 * - requireTLS: true
 * - STARTTLS is used
 */
const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: false,
  requireTLS: true,

  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },

  // Connection timeout
  connectionTimeout: 30_000,

  // Socket timeout
  socketTimeout: 60_000,

  // Useful temporarily while debugging Vercel
  logger: true,
  debug: true,
});

export async function sendEmail({
  to,
  subject,
  html,
  text,
  campaignId = process.env.MAILERCLOUD_CAMPAIGN_ID,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  campaignId?: string;
}) {
  console.log("\n==========================================");
  console.log("📧 SEND EMAIL START");
  console.log("==========================================");

  console.log("Recipient:", to);
  console.log("Subject:", subject);
  console.log("HTML length:", html?.length || 0);
  console.log("Text length:", text?.length || 0);
  console.log("Campaign ID:", campaignId ? "SET" : "NOT SET");

  // ----------------------------------------
  // 1. Validate environment variables
  // ----------------------------------------

  const missing = [
    ["SMTP_HOST", process.env.SMTP_HOST],
    ["SMTP_USER", process.env.SMTP_USER],
    ["SMTP_PASS", process.env.SMTP_PASS],
    [
      "MAILERCLOUD_FROM_EMAIL or FROM_EMAIL",
      process.env.MAILERCLOUD_FROM_EMAIL || process.env.FROM_EMAIL,
    ],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  console.log("Missing environment variables:", missing);

  if (missing.length > 0) {
    console.error("❌ EMAIL CONFIGURATION ERROR:", missing.join(", "));

    throw new Error(`Email is not configured; missing: ${missing.join(", ")}`);
  }

  console.log("✅ Required email environment variables are present");

  // ----------------------------------------
  // 2. Tracking headers
  // ----------------------------------------

  const headers = campaignId
    ? {
        "mld-track-campaign-id": campaignId,
        "mld-track-opens": "true",
        "mld-track-clicks": "true",
        "mld-track-inbox": "true",
      }
    : undefined;

  console.log("Tracking headers:", headers ? "ENABLED" : "DISABLED");

  // ----------------------------------------
  // 3. FROM address
  // ----------------------------------------

  const fromEmail =
    process.env.FROM_EMAIL || process.env.MAILERCLOUD_FROM_EMAIL;

  const fromName =
    process.env.FROM_NAME || process.env.MAILERCLOUD_FROM_NAME || "Fiona Loans";

  const from = `"${fromName}" <${fromEmail}>`;

  console.log("From:", from);
  console.log("SMTP Host:", smtpHost);
  console.log("SMTP Port:", smtpPort);
  console.log("SMTP Secure:", smtpSecure);
  console.log("SMTP Require TLS:", smtpRequireTLS);

  // ----------------------------------------
  // 4. Verify SMTP connection
  // ----------------------------------------

  try {
    console.log("\n🔌 Testing SMTP connection...");
    console.log("Waiting for SMTP server...");

    const verifyStart = Date.now();

    await transporter.verify();

    const verifyDuration = Date.now() - verifyStart;

    console.log("✅ SMTP connection verified successfully");

    console.log("SMTP verify duration:", `${verifyDuration}ms`);
  } catch (verifyError: any) {
    console.error("\n==========================================");
    console.error("❌ SMTP VERIFY FAILED");
    console.error("==========================================");

    console.error("Error name:", verifyError?.name);

    console.error("Error message:", verifyError?.message);

    console.error("Error code:", verifyError?.code);

    console.error("Error command:", verifyError?.command);

    console.error("Error response:", verifyError?.response);

    console.error("Error responseCode:", verifyError?.responseCode);

    console.error("Error errno:", verifyError?.errno);

    console.error("Error syscall:", verifyError?.syscall);

    console.error("Error address:", verifyError?.address);

    console.error("Error port:", verifyError?.port);

    console.error("Error stack:", verifyError?.stack);

    console.error("==========================================\n");

    throw verifyError;
  }

  // ----------------------------------------
  // 5. Send email
  // ----------------------------------------

  try {
    console.log("\n📨 Calling transporter.sendMail()...");

    const startTime = Date.now();

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text,
      headers,
    });

    const duration = Date.now() - startTime;

    // ----------------------------------------
    // 6. Success logs
    // ----------------------------------------

    console.log("\n==========================================");
    console.log("✅ EMAIL SENT SUCCESSFULLY");
    console.log("==========================================");

    console.log("Recipient:", to);
    console.log("Message ID:", info.messageId);
    console.log("Response:", info.response);
    console.log("Accepted:", info.accepted);
    console.log("Rejected:", info.rejected);
    console.log("Pending:", info.pending);
    console.log("Duration:", `${duration}ms`);

    console.log("==========================================\n");

    return info;
  } catch (err: any) {
    // ----------------------------------------
    // 7. Detailed send error
    // ----------------------------------------

    console.error("\n==========================================");
    console.error("❌ EMAIL SEND FAILED");
    console.error("==========================================");

    console.error("Recipient:", to);
    console.error("Subject:", subject);

    console.error("\n--- Error Details ---");

    console.error("Name:", err?.name);

    console.error("Message:", err?.message);

    console.error("Code:", err?.code);

    console.error("Command:", err?.command);

    console.error("Response:", err?.response);

    console.error("Response Code:", err?.responseCode);

    console.error("Errno:", err?.errno);

    console.error("Syscall:", err?.syscall);

    console.error("Address:", err?.address);

    console.error("Port:", err?.port);

    console.error("\n--- SMTP Configuration ---");

    console.error("SMTP Host:", process.env.SMTP_HOST);

    console.error("SMTP Port:", smtpPort);

    console.error("SMTP Secure:", smtpSecure);

    console.error("SMTP Require TLS:", smtpRequireTLS);

    console.error("SMTP User:", process.env.SMTP_USER);

    console.error("SMTP Password:", process.env.SMTP_PASS ? "SET" : "MISSING");

    console.error("\n--- Stack ---");

    console.error(err?.stack);

    console.error("\n--- Full Error Object ---");

    console.error(err);

    console.error("==========================================\n");

    throw err;
  }
}
