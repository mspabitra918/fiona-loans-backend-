import { sendMailgunEmail } from "./emailService";

/**
 * Copy for the drip sequences. The timing lives in `queue/dripConfig.ts`; this
 * module only knows how to render email #N.
 *
 * Verification track (status `bank_verification_pending`):
 *   1      application submitted — call us to finalize
 *   2      secure bank verification link
 *   3-7    verification reminder (same copy, repeats every 12h)
 *   8      final cancellation notice
 *
 * Call track (status `bank_verification_completed`):
 *   11-14  reminder to call underwriting (same copy, repeats every 12h)
 *
 * The verification CTA is a one-click deep link to the bank verification screen
 * using the existing `?applicationId=` pattern (no separate borrower auth/token
 * system exists yet).
 */

export interface DripEmailDetails {
  applicationId: string;
  firstName: string;
  email: string;
  loanAmount: number;
}

/** Where a template's CTA button points. */
type CtaTarget = "verify" | "phone" | "home";

interface DripTemplate {
  subject: string;
  // heading: string;
  /** Accent colour for the heading + CTA button. */
  accent: string;
  /** Lead paragraph(s); plain strings rendered as <p>. May contain inline HTML. */
  body: string[];
  cta: { label: string; target: CtaTarget };
  /** Lines of the sign-off, rendered as one <p> separated by <br />. */
  signOff: string[];
}

const VERIFY_PATH = "/verify-bank";
const PHONE_DISPLAY = "(747) 208-0334";
const PHONE_HREF = "tel:+17472080334";
const HOME_URL = "https://www.brookloans.com";

/** `(747) 208-0334` as a tel: link, for use inside body copy. */
const PHONE_LINK = `<a href="${PHONE_HREF}" style="color: #1a56db; text-decoration: none;">${PHONE_DISPLAY}</a>`;

const APPLICATION_SUBMITTED: DripTemplate = {
  subject: "Action Required: Finalize your Brook Loans Application",
  // heading: "Your application is on hold",
  accent: "#14532d",
  body: [
    "Your secure application has been successfully submitted to Brook Loans!",
    "Because we believe in transparent, human-first underwriting, your application is currently on hold until we speak with you. To finalize your fixed 10% APR terms and move forward with funding, you must complete a brief review with our team over the phone.",
    `Please call us right now to finalize your loan:<br /><strong>&#128222; ${PHONE_LINK}</strong><br /><em>Hours: Monday &ndash; Friday, 06:00 AM &ndash; 04:00 PM PST</em>`,
  ],
  cta: { label: `Call ${PHONE_DISPLAY}`, target: "phone" },
  signOff: ["Best regards,", "The Underwriting Team at Brook Loans"],
};

const BANK_VERIFICATION_LINK: DripTemplate = {
  subject: "Next Step: Securely Verify Your Bank Account",
  // heading: "Securely verify your bank account",
  accent: "#1a56db",
  body: [
    "We received your application a couple of hours ago, but we still need to verify your active bank account before we can approve your funds for deposit.",
    "To protect your financial data, Brook Loans uses bank-grade encryption to verify your account status. We will never see or store your online banking login credentials.",
    "Please click the secure link below to connect your institution.",
    `Once this quick step is completed, please call our underwriting team at ${PHONE_LINK} so we can finalize your loan agreement.`,
  ],
  cta: { label: "Securely Verify My Bank Account", target: "verify" },
  signOff: ["Best,", "The Underwriting Team at Brook Loans"],
};

const BANK_VERIFICATION_REMINDER: DripTemplate = {
  subject: "Reminder: Verify your bank account to receive your funds",
  // heading: "Your application is almost complete",
  accent: "#f59e0b",
  body: [
    "Your Brook Loans application is almost complete, but your file is currently paused. We still need you to verify your bank account so we know exactly where to send your funds once approved.",
    "This process is fully encrypted and takes less than 60 seconds.",
    `If you are experiencing any issues linking your account, our Los Angeles-based team is ready to help. Give us a call at ${PHONE_LINK}.`,
  ],
  cta: { label: "Securely Verify My Bank Account", target: "verify" },
  signOff: ["Best,", "Brook Loans Customer Support"],
};

const FINAL_CANCELLATION: DripTemplate = {
  subject: "Notice: Your Brook Loans application has been closed",
  // heading: "Your application has been closed",
  accent: "#dc2626",
  body: [
    "We have tried to reach out a few times to help you complete your bank verification, but we haven't received a response.",
    "At this time, we have officially closed your current loan application, and no further action will be taken. Because we only use a soft credit pull to check eligibility, this cancellation will not impact your credit score.",
    "If you decide you would still like to secure a fixed 10% APR personal loan in the future, you are always welcome to start a new application on our website.",
  ],
  cta: { label: "Start a New Application", target: "home" },
  signOff: ["We wish you the best!", "Sincerely,", "The Team at Brook Loans"],
};

const CALL_REMINDER: DripTemplate = {
  subject: "Don't lose your spot: Call Brook Loans to finalize your loan",
  // heading: "Your loan application is waiting",
  accent: "#f59e0b",
  body: [
    "Your loan application is sitting securely in our system, but it cannot move forward until you speak with our underwriting team.",
    "At Brook Loans, we don't rely entirely on automated bots. We want to ensure you fully understand your fixed 10% APR terms, with absolutely zero hidden fees or prepayment penalties.",
    "It takes less than five minutes on the phone to review your details and get your funds prepared for release.",
    `Call us today at ${PHONE_LINK} to get your money moving.`,
  ],
  cta: { label: `Call ${PHONE_DISPLAY}`, target: "phone" },
  signOff: ["Best,", "The Underwriting Team at Brook Loans"],
};

const TEMPLATES: Record<number, DripTemplate> = {
  1: APPLICATION_SUBMITTED,
  2: BANK_VERIFICATION_LINK,
  3: BANK_VERIFICATION_REMINDER,
  4: BANK_VERIFICATION_REMINDER,
  5: BANK_VERIFICATION_REMINDER,
  6: BANK_VERIFICATION_REMINDER,
  7: BANK_VERIFICATION_REMINDER,
  8: FINAL_CANCELLATION,
  11: CALL_REMINDER,
  12: CALL_REMINDER,
  13: CALL_REMINDER,
  14: CALL_REMINDER,
};

function ctaHref(target: CtaTarget, applicationId: string): string {
  switch (target) {
    case "verify":
      return `${process.env.FRONTEND_URL}${VERIFY_PATH}?applicationId=${applicationId}`;
    case "phone":
      return PHONE_HREF;
    case "home":
      return process.env.FRONTEND_URL || HOME_URL;
  }
}

function renderDripEmail(
  template: DripTemplate,
  details: DripEmailDetails,
): string {
  const { applicationId, firstName, loanAmount } = details;

  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(loanAmount);

  const paragraphs = template.body
    .map(
      (p) =>
        `<p style="color: #374151; font-size: 16px; line-height: 1.5;">${p}</p>`,
    )
    .join("\n");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #F0FFF4; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
  <h1
    style="
      margin: 0;
      font-size: 32px;
      font-weight: 700;
      color: #14532d;
      font-family: Arial, Helvetica, sans-serif;
      letter-spacing: 0.5px;
    "
  >
    Brook Loans
  </h1>
</div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 30px; border-radius: 0 0 8px 8px;">
        <p style="color: #374151; font-size: 16px;">Hi ${firstName},</p>
        ${paragraphs}
        <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Application ID</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: bold; text-align: right;">${applicationId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Loan Amount</td>
              <td style="padding: 8px 0; color: #111827; font-size: 14px; font-weight: bold; text-align: right;">${formattedAmount}</td>
            </tr>
          </table>
        </div>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${ctaHref(template.cta.target, applicationId)}" style="background: ${template.accent}; color: #ffffff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; display: inline-block;">${template.cta.label}</a>
        </div>
        <p style="color: #374151; font-size: 16px; margin-top: 24px;">
          ${template.signOff.join("<br />\n          ")}
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <div style="text-align: center; padding: 10px 0;">
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Phone:</strong> ${PHONE_LINK}
          </p>
          <p style="color: #374151; font-size: 14px; margin: 5px 0;">
            <strong>Website:</strong> <a href="${HOME_URL}" style="color: #1a56db; text-decoration: none;">www.brookloans.com</a>
          </p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          This is an automated email from Brook Loans. Please do not reply to this email.
        </p>
      </div>
    </div>
  `;
}

/**
 * Sends drip email #`emailNumber`. The caller (worker) is responsible for the
 * kill-switch check and idempotency before invoking this.
 */
export async function sendDripEmail(
  emailNumber: number,
  details: DripEmailDetails,
): Promise<void> {
  const template = TEMPLATES[emailNumber];
  if (!template) {
    throw new Error(`No drip template for email #${emailNumber}`);
  }

  const html = renderDripEmail(template, details);
  await sendMailgunEmail(details.email, template.subject, html);
}
