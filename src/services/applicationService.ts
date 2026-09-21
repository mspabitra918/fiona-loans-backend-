import { query, queryOne, execute, transaction, type DbClient } from "../db";
import { encrypt, hashSSN, decrypt } from "../encryption";
import { sanitizeInput } from "../validation";
import { generateUniqueId } from "../utils";
import { cancelDripSequence, enqueueDripSequence } from "../queue/dripQueue";
import { tracksBlockedByStatus } from "../queue/dripConfig";
import { pacificDayRange } from "../timezone";
import { randomUUID } from "node:crypto";
import { validate as isUuid } from "uuid";

/**
 * Cancels the drip tracks a new status locks out. Both the verify and call
 * tracks are gated on `bank_verification_pending`, so any other status — most
 * commonly `bank_verification_completed` — drops both. Never throws: drip
 * bookkeeping must not fail a status update.
 */
async function syncDripTracksForStatus(
  id: string,
  status: string,
): Promise<void> {
  console.log("Blocked tracks:", status, tracksBlockedByStatus(status));
  await cancelDripSequence(id, tracksBlockedByStatus(status));
}

export interface CreateApplicationInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  ssn: string;
  driverLicenseNumber: string;
  driverLicenseState: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  employmentStatus: string;
  employerName: string;
  jobTitle: string;
  monthlyIncome: number;
  yearsEmployed: number;
  loanAmount: number;
  loanPurpose: string;
  loanTerm: number;
  bankName: string;
  accountNumber: string;
  routingNumber: string;
  bankAccountAge: string;
  bankBalanceStatus: string;
  accountType: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  assistedByLoanAgent?: string;
  tcpaConsent: boolean;
  privacyConsent: boolean;
  creditCheckConsent: boolean;
  ipAddress: string;
  userAgent: string;
  leadId?: string;
}

export interface SaveApplicationStepInput {
  sessionId: string;
  /**
   * The public 5-digit code the client already holds, when it has one. Used as a
   * fallback key so a client that lost its session id still updates its own row
   * rather than starting a second application.
   */
  applicationId?: string;
  step: number;
  data: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  pageUrl?: string;
  referrerUrl?: string;
}

export interface ApplicantIdentityMatch {
  email: string;
  phone: string;
  dateOfBirth: string;
  lastName: string;
}

/**
 * Raised when a step payload cannot be persisted as-is. The route turns this
 * into a 400 naming the offending field instead of an opaque 500 — a CHECK or
 * NOT NULL violation surfacing from Postgres tells the applicant nothing.
 */
export class ApplicationStepValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ApplicationStepValidationError";
    this.field = field;
  }
}

/**
 * The value domains enforced by the CHECK constraints on `loan_applications`.
 * Keep these in lockstep with schema.sql: a value that is not listed here is one
 * Postgres will reject, which aborts the whole step save.
 */
const ENUM_DOMAINS = {
  timeAtAddress: {
    values: [
      "under_6_months",
      "6_11_months",
      "1_2_years",
      "3_5_years",
      "5_plus_years",
    ],
    labels: { "5_years": "5_plus_years" },
  },
  // Deliberately NOT the same domain as timeAtAddress — it has `under_3_months`
  // and `3_5_months` where the address list has a single `under_6_months`.
  timeAtJob: {
    values: [
      "under_3_months",
      "3_5_months",
      "6_11_months",
      "1_2_years",
      "3_5_years",
      "5_plus_years",
    ],
    labels: { "5_years": "5_plus_years" },
  },
  housingStatus: {
    values: [
      "rent",
      "own_with_mortgage",
      "own_outright",
      "living_with_family_friends",
      "military_housing",
      "other",
    ],
    labels: {
      living_with_family_or_friends: "living_with_family_friends",
      live_with_family: "living_with_family_friends",
    },
  },
  employmentStatus: {
    values: [
      "employed_full_time",
      "employed_part_time",
      "self_employed",
      "active_military",
      "retired",
      "disability",
      "social_security",
      "unemployment_benefits",
      "other_benefits",
      "student",
      "not_currently_employed",
    ],
    labels: { other: "other_benefits" },
  },
  primaryIncomeType: {
    values: [
      "employment",
      "self_employment",
      "retirement_pension",
      "social_security",
      "disability",
      "unemployment",
      "other",
    ],
    labels: { retirement_or_pension: "retirement_pension" },
  },
  payFrequency: {
    values: [
      "weekly",
      "every_two_weeks",
      "twice_a_month",
      "monthly",
      "irregular",
    ],
    labels: {
      bi_weekly: "every_two_weeks",
      biweekly: "every_two_weeks",
      semi_monthly: "twice_a_month",
    },
  },
  bankAccountAge: {
    values: [
      "under_6_months",
      "1_year",
      "2_years",
      "3_years",
      "4_years",
      "5_plus_years",
    ],
    labels: { "5_years": "5_plus_years" },
  },
  bankBalanceStatus: {
    values: ["positive_balance", "overdrawn"],
    labels: { positive: "positive_balance", negative: "overdrawn" },
  },
  accountType: { values: ["checking", "savings"], labels: {} },
  suffix: {
    values: ["None", "Jr", "Sr", "II", "III", "IV"],
    labels: { junior: "Jr", senior: "Sr" },
  },
} as const satisfies Record<
  string,
  { values: readonly string[]; labels: Record<string, string> }
>;

const LOAN_TERMS = [12, 24, 36, 48];

/** The wizard's last step — banking details. */
const FINAL_APPLICATION_STEP = 3;

/**
 * Resolves a submitted value to one the database will accept. The wizard sends
 * the stored value (`own_with_mortgage`), but saved drafts and admin edits can
 * still carry the display label ("Own with mortgage"), so both are matched.
 * Anything unrecognised becomes `fallback` rather than a constraint violation.
 */
function normalizeEnum(
  raw: unknown,
  domain: { values: readonly string[]; labels: Record<string, string> },
  fallback: string | null = null,
): string | null {
  const candidate = String(raw ?? "").trim();
  if (!candidate) return fallback;

  const exact = domain.values.find((value) => value === candidate);
  if (exact) return exact;

  const caseInsensitive = domain.values.find(
    (value) => value.toLowerCase() === candidate.toLowerCase(),
  );
  if (caseInsensitive) return caseInsensitive;

  // "Employed — Full Time" and "3–5 years" both slug to the stored value.
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const bySlug = domain.values.find((value) => value === slug);
  if (bySlug) return bySlug;

  const mapped = domain.labels[candidate] ?? domain.labels[slug];
  return mapped && domain.values.includes(mapped) ? mapped : fallback;
}

/**
 * Parses a date into `YYYY-MM-DD`, returning null instead of throwing on junk.
 * Formats the local calendar date rather than going through toISOString(), which
 * shifts "04/12/1990" (parsed as local midnight) back a day east of UTC.
 */
function toDateOnly(raw: unknown): string | null {
  const candidate = String(raw ?? "").trim();
  if (!candidate) return null;

  // Already a date-only string — take it verbatim, no timezone in play.
  const isoDateOnly = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const parsed = new Date(`${candidate}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : candidate;
  }

  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return null;

  return [
    String(parsed.getFullYear()).padStart(4, "0"),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Parses a currency-ish input ("1,200", "$1200") into a finite number. */
function toAmount(raw: unknown): number {
  const parsed = Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Trims free text to the column width so a long paste cannot abort the save. */
function clip(raw: unknown, maxLength: number): string {
  return String(raw ?? "")
    .trim()
    .slice(0, maxLength);
}

/** True when the applicant actually supplied something for this field. */
function hasValue(raw: unknown): boolean {
  return raw !== undefined && raw !== null && String(raw).trim() !== "";
}

/**
 * Checks the numeric/date columns whose CHECK and NOT NULL constraints cannot be
 * coalesced away. Out-of-range input has to be caught here: once Postgres raises
 * the violation the step save is lost and the applicant sees a generic failure.
 */
function assertPersistableRanges(
  merged: Record<string, unknown>,
  isNewApplication: boolean,
): void {
  const range = (
    key: string,
    field: string,
    label: string,
    min: number,
    max: number,
    required: boolean,
  ) => {
    if (!hasValue(merged[key])) {
      if (required && isNewApplication) {
        throw new ApplicationStepValidationError(field, `${label} is required.`);
      }
      return;
    }

    const amount = toAmount(merged[key]);
    if (amount < min || amount > max) {
      throw new ApplicationStepValidationError(
        field,
        `${label} must be between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}.`,
      );
    }
  };

  range("loanAmount", "loanAmount", "Loan amount", 1000, 10000, true);
  range(
    "netMonthlyIncome",
    "netMonthlyIncome",
    "Net monthly income",
    500,
    50000,
    true,
  );
  range(
    "additionalMonthlyIncome",
    "additionalMonthlyIncome",
    "Additional monthly income",
    0,
    20000,
    false,
  );
  range(
    "monthlyHousingPayment",
    "monthlyHousingPayment",
    "Monthly housing payment",
    0,
    15000,
    false,
  );

  if (hasValue(merged.dob)) {
    if (!toDateOnly(merged.dob)) {
      throw new ApplicationStepValidationError(
        "dob",
        "Date of birth is not a valid date.",
      );
    }
  } else if (isNewApplication) {
    throw new ApplicationStepValidationError(
      "dob",
      "Date of birth is required.",
    );
  }

  if (hasValue(merged.nextPayDate) && !toDateOnly(merged.nextPayDate)) {
    throw new ApplicationStepValidationError(
      "nextPayDate",
      "Next pay date is not a valid date.",
    );
  }

  if (hasValue(merged.dlExpiration) && !toDateOnly(merged.dlExpiration)) {
    throw new ApplicationStepValidationError(
      "dlExpiration",
      "Driver's license expiration is not a valid date.",
    );
  }
}

export interface DerivedApplicationFields {
  applicantAge: number | null;
  grossAnnualIncome: number;
  totalMonthlyIncome: number;
  debtToIncomeRatio: number;
  disposableIncome: number;
  paymentToIncomeRatio: number;
  jobTenureMonths: number;
  residenceTenureMonths: number;
  estimatedInstallment: number;
}

export function calculateDerivedApplicationFields(
  data: Record<string, unknown>,
): DerivedApplicationFields {
  const dob = data.dob ? new Date(String(data.dob)) : null;
  const applicantAge =
    dob && !Number.isNaN(dob.getTime())
      ? Math.floor((Date.now() - dob.getTime()) / 31557600000)
      : null;
  const netMonthlyIncome = Number(data.netMonthlyIncome || 0);
  const additionalMonthlyIncome = Number(data.additionalMonthlyIncome || 0);
  const totalMonthlyIncome = netMonthlyIncome + additionalMonthlyIncome;
  const grossAnnualIncome = Math.round(totalMonthlyIncome * 12 * 1.28);
  const housingPayment = Number(data.monthlyHousingPayment || 0);
  const bureauObligations = Number(data.bureauReportedObligations || 0);
  const debtToIncomeRatio =
    totalMonthlyIncome > 0
      ? Number(
          (
            ((housingPayment + bureauObligations) / totalMonthlyIncome) *
            100
          ).toFixed(1),
        )
      : 0;
  const disposableIncome = Math.round(
    totalMonthlyIncome - housingPayment - bureauObligations,
  );
  const term = Number(data.loanTerm || 36);
  const principal = Number(data.loanAmount || 0);
  const monthlyRate = 0.1199 / 12;
  const estimatedInstallment =
    principal > 0
      ? Math.round(
          (principal * monthlyRate * (1 + monthlyRate) ** term) /
            ((1 + monthlyRate) ** term - 1),
        )
      : 0;
  const paymentToIncomeRatio =
    totalMonthlyIncome > 0
      ? Number(((estimatedInstallment / totalMonthlyIncome) * 100).toFixed(1))
      : 0;
  // Tenure buckets arrive as the stored value (`1_2_years`), so normalize before
  // looking up the midpoint — matching on display labels silently yields 0.
  const midpoint = (
    value: unknown,
    domain: { values: readonly string[]; labels: Record<string, string> },
    ranges: Array<[string, number]>,
  ): number => {
    const normalized = normalizeEnum(value, domain);
    return ranges.find(([key]) => key === normalized)?.[1] ?? 0;
  };

  return {
    applicantAge,
    grossAnnualIncome,
    totalMonthlyIncome,
    debtToIncomeRatio,
    disposableIncome,
    paymentToIncomeRatio,
    estimatedInstallment,
    jobTenureMonths: midpoint(data.timeAtJob, ENUM_DOMAINS.timeAtJob, [
      ["under_3_months", 2],
      ["3_5_months", 4],
      ["6_11_months", 9],
      ["1_2_years", 18],
      ["3_5_years", 48],
      ["5_plus_years", 72],
    ]),
    residenceTenureMonths: midpoint(
      data.timeAtAddress,
      ENUM_DOMAINS.timeAtAddress,
      [
        ["under_6_months", 3],
        ["6_11_months", 9],
        ["1_2_years", 18],
        ["3_5_years", 48],
        ["5_plus_years", 72],
      ],
    ),
  };
}

export async function findMatchingApplication(
  identity: ApplicantIdentityMatch,
  sessionId?: string,
): Promise<{ applicationId: string; status: string } | null> {
  return queryOne(
    `SELECT application_id AS "applicationId", status
     FROM loan_applications
     WHERE LOWER(email) = LOWER($1)
       AND REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = REGEXP_REPLACE($2, '[^0-9]', '', 'g')
       AND date_of_birth = $3::date
       AND LOWER(last_name) = LOWER($4)
       AND ($5::text IS NULL OR session_id IS DISTINCT FROM $5)
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      identity.email.trim(),
      identity.phone,
      // `''::date` raises 22007 — a blank or unparseable DOB has to become NULL,
      // which simply matches nothing.
      toDateOnly(identity.dateOfBirth),
      identity.lastName.trim(),
      sessionId || null,
    ],
  );
}

export async function findRecentDecline(
  identity: ApplicantIdentityMatch,
): Promise<{ applicationId: string; status: string } | null> {
  return queryOne(
    `SELECT application_id AS "applicationId", status
     FROM loan_applications
     WHERE LOWER(email) = LOWER($1)
       AND REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = REGEXP_REPLACE($2, '[^0-9]', '', 'g')
       AND date_of_birth = $3::date
       AND LOWER(last_name) = LOWER($4)
       AND status IN ('declined', 'declined_pb', 'declined_hd', 'rejected')
       AND created_at >= NOW() - INTERVAL '90 days'
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      identity.email.trim(),
      identity.phone,
      toDateOnly(identity.dateOfBirth),
      identity.lastName.trim(),
    ],
  );
}

/**
 * Rows that are still mid-wizard and may therefore be resumed. Anything past
 * bank verification is a decided application: a late step save must never
 * reopen one.
 */
const RESUMABLE_STATUSES = ["draft", "prequalified", "identity_verified"];

interface ExistingApplicationRow {
  id: string;
  application_id: string;
  application_data: Record<string, unknown>;
  step_number: number;
  session_id: string;
  status: string;
}

const EXISTING_APPLICATION_COLUMNS = `
  id,
  application_id,
  application_data,
  step_number,
  session_id,
  status
`;

/**
 * Last-resort lookup for a step 2/3 save whose session id and application id
 * are both gone — a resume from another device, or after site data was cleared.
 * Matching on the same four identity fields as the step 1 duplicate guard keeps
 * the applicant on the row step 1 created instead of forking a new one.
 */
export async function findResumableApplicationByIdentity(
  identity: ApplicantIdentityMatch,
): Promise<ExistingApplicationRow | null> {
  const dateOfBirth = toDateOnly(identity.dateOfBirth);
  if (!identity.email.trim() || !identity.lastName.trim() || !dateOfBirth) {
    return null;
  }

  return queryOne<ExistingApplicationRow>(
    `SELECT ${EXISTING_APPLICATION_COLUMNS}
     FROM loan_applications
     WHERE LOWER(email) = LOWER($1)
       AND REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = REGEXP_REPLACE($2, '[^0-9]', '', 'g')
       AND date_of_birth = $3::date
       AND LOWER(last_name) = LOWER($4)
       AND status = ANY($5::text[])
       AND created_at >= NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      identity.email.trim(),
      identity.phone,
      dateOfBirth,
      identity.lastName.trim(),
      RESUMABLE_STATUSES,
    ],
  );
}

export interface SoftPullDecision {
  decision: "prequalified" | "declined";
  reason: string;
}

export function runSoftPullPrequalification(
  data: Record<string, unknown>,
): SoftPullDecision {
  const income = Number(data.netMonthlyIncome ?? 0);
  const loanAmount = Number(data.loanAmount ?? 0);

  if (income < 500 || loanAmount < 1000) {
    return { decision: "declined", reason: "income_or_loan_amount_ineligible" };
  }

  return { decision: "prequalified", reason: "soft_pull_eligibility_passed" };
}

export interface MlaCheckInput {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  ssn: string;
}

export async function runMlaCoveredBorrowerCheck(
  input: MlaCheckInput,
): Promise<{ required: boolean; coveredBorrower: boolean }> {
  const maxMapr = Number(process.env.PRODUCT_MAX_MAPR_PERCENT ?? 0);
  if (maxMapr <= 36) {
    return { required: false, coveredBorrower: false };
  }

  const endpoint = process.env.MLA_CHECK_URL;
  if (!endpoint) {
    throw new Error("MLA_CHECK_URL is required when product MAPR exceeds 36%");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.MLA_CHECK_API_KEY
        ? { Authorization: `Bearer ${process.env.MLA_CHECK_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: input.dateOfBirth,
      ssn: input.ssn.replace(/\D/g, ""),
    }),
  });

  if (!response.ok) {
    throw new Error(`MLA check failed with status ${response.status}`);
  }

  const result = (await response.json()) as { coveredBorrower?: boolean };
  if (typeof result.coveredBorrower !== "boolean") {
    throw new Error("MLA check returned an invalid response");
  }

  return { required: true, coveredBorrower: result.coveredBorrower };
}

export async function saveApplicationStep(
  input: SaveApplicationStepInput,
): Promise<{
  applicationId: string;
  status: string;
  derivedData: DerivedApplicationFields;
}> {
  // ============================================================
  // 1. FIND EXISTING APPLICATION
  // ============================================================

  let existing = await queryOne<ExistingApplicationRow>(
    `SELECT ${EXISTING_APPLICATION_COLUMNS}
     FROM loan_applications
     WHERE session_id = $1
        OR id::text = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.sessionId],
  );

  // The session id is the primary key of the wizard, but it does not always
  // survive the round trip — a closed tab, a cleared browser, a different
  // device. Each fallback below re-attaches the save to the row step 1 created;
  // without them the row is missing and a second application gets minted with
  // its own number and status, which is what admins saw as duplicates.
  if (!existing && input.applicationId) {
    existing = await queryOne<ExistingApplicationRow>(
      `SELECT ${EXISTING_APPLICATION_COLUMNS}
       FROM loan_applications
       WHERE application_id = $1
         AND status = ANY($2::text[])
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.applicationId, RESUMABLE_STATUSES],
    );
  }

  if (!existing && input.step > 1) {
    existing = await findResumableApplicationByIdentity({
      email: String(input.data.email || ""),
      phone: String(input.data.mobilePhone || input.data.phone || ""),
      dateOfBirth: String(input.data.dob || input.data.dateOfBirth || ""),
      lastName: String(input.data.lastName || ""),
    });
  }

  // ============================================================
  // 2. MERGE APPLICATION DATA
  // ============================================================

  const mergedData = {
    ...(existing?.application_data ?? {}),
    ...(input.data ?? {}),
  } as Record<string, unknown>;

  const id = existing?.id ?? randomUUID();

  // generateUniqueId checks-then-inserts, so two concurrent step saves can pick
  // the same 5-digit code. The write below retries on the unique violation.
  let applicationId =
    existing?.application_id ??
    (await generateUniqueId("loan_applications", "application_id"));

  // ============================================================
  // 3. STEP MAP
  // ============================================================

  const stepMap = {
    1: "step1",
    2: "step2",
    3: "step3",
  } as const;

  // ============================================================
  // 4. RESOLVE STATUS
  // ============================================================

  const resolvedStatus =
    input.step === 1
      ? input.data.prequalDecision === "declined"
        ? "declined"
        : "prequalified"
      : input.step === 2
        ? input.data.prequalDecision === "declined"
          ? "declined"
          : "prequalified"
        : (input.data as Record<string, unknown>).bankAuthMode === "manual"
          ? "bank_verification_pending"
          : "bank_verification_completed";

  // ============================================================
  // 5. REMOVE SENSITIVE VALUES FROM application_data
  // ============================================================

  const {
    ssn,
    confirmSsn,
    dlNumber,
    accountNumber,
    confirmAccountNumber,
    routingNumber,
    ...safeMergedData
  } = mergedData;

  // ============================================================
  // 6. DERIVED DATA
  // ============================================================

  const derivedData = calculateDerivedApplicationFields(mergedData);

  // ============================================================
  // 7. APPLICATION JSON DATA
  // ============================================================

  const applicationData = {
    ...safeMergedData,
    derivedData,
    sessionId: input.sessionId,
    clientIp: input.ipAddress,
    userAgent: input.userAgent,
    pageUrl: input.pageUrl || mergedData.pageUrl || "",
    referrerUrl: input.referrerUrl || mergedData.referrerUrl || "",
    step1StartedAt:
      (mergedData.step1StartedAt as string) || new Date().toISOString(),
    step1SubmittedAt:
      input.step === 1 ? new Date().toISOString() : mergedData.step1SubmittedAt,
    step2SubmittedAt:
      input.step === 2 ? new Date().toISOString() : mergedData.step2SubmittedAt,
    step3SubmittedAt:
      input.step === 3 ? new Date().toISOString() : mergedData.step3SubmittedAt,
  };

  // ============================================================
  // 8. BASE VALUES
  // ============================================================

  assertPersistableRanges(mergedData, !existing);

  const loanTerm = Number(mergedData.loanTerm ?? 0);

  const baseValues = {
    first_name: clip(mergedData.firstName, 40),

    last_name: clip(mergedData.lastName, 40),

    email: clip(mergedData.email, 255),

    phone: clip(mergedData.mobilePhone || mergedData.phone, 20),

    date_of_birth: toDateOnly(mergedData.dob),

    street_address: clip(mergedData.streetAddress, 100),

    city: clip(mergedData.city, 50),

    state: clip(mergedData.state, 5),

    zip_code: clip(mergedData.zipCode, 5),

    loan_amount: toAmount(mergedData.loanAmount),

    loan_purpose: clip(mergedData.loanPurpose, 50),

    // IMPORTANT
    loan_purpose_other_detail: clip(
      mergedData.purposeOtherDetail || mergedData.loan_purpose_other_detail,
      120,
    ),

    // Nullable column with a CHECK — an unsupported term is dropped rather than
    // taking the whole save down with it.
    loan_term: LOAN_TERMS.includes(loanTerm) ? loanTerm : null,

    time_at_current_address: normalizeEnum(
      mergedData.timeAtAddress,
      ENUM_DOMAINS.timeAtAddress,
      "under_6_months",
    ) as string,

    housing_status: normalizeEnum(
      mergedData.housingStatus,
      ENUM_DOMAINS.housingStatus,
      "other",
    ) as string,

    employment_status: normalizeEnum(
      mergedData.employmentStatus,
      ENUM_DOMAINS.employmentStatus,
      "not_currently_employed",
    ) as string,

    primary_income_type: normalizeEnum(
      mergedData.primaryIncomeType,
      ENUM_DOMAINS.primaryIncomeType,
      "other",
    ) as string,

    // Null means "leave whatever is already stored" — passing 0 for a step that
    // simply does not carry income would wipe the step-1 value and trip its CHECK.
    net_monthly_income: hasValue(mergedData.netMonthlyIncome)
      ? toAmount(mergedData.netMonthlyIncome)
      : null,

    pay_frequency: normalizeEnum(
      mergedData.payFrequency,
      ENUM_DOMAINS.payFrequency,
      "irregular",
    ) as string,

    direct_deposit: [true, "Yes", "yes", "true"].includes(
      mergedData.directDeposit as never,
    ),

    additional_monthly_income: hasValue(mergedData.additionalMonthlyIncome)
      ? toAmount(mergedData.additionalMonthlyIncome)
      : null,

    additional_income_source: clip(mergedData.additionalIncomeSource, 50),

    ip_address: clip(input.ipAddress, 45) || "unknown",

    user_agent: input.userAgent,
  };

  // ============================================================
  // 9. ENCRYPT SENSITIVE VALUES
  // ============================================================

  const encryptedSsn = ssn ? encrypt(String(ssn)) : null;

  const encryptedDlNumber = dlNumber ? encrypt(String(dlNumber)) : null;

  const encryptedAccountNumber = accountNumber
    ? encrypt(String(accountNumber))
    : null;

  const encryptedRoutingNumber = routingNumber
    ? encrypt(String(routingNumber))
    : null;

  const ssnHash = ssn ? hashSSN(String(ssn).replace(/\D/g, "")) : null;

  // ============================================================
  // 10. PLAID DETAILS
  // ============================================================

  const plaidDetails = (mergedData.plaidDetails || {}) as Record<
    string,
    unknown
  >;

  // ============================================================
  // 11. ACCOUNT AGE
  // Frontend sends values such as:
  // under_6_months
  // 1_year
  // 2_years
  // 3_years
  // 4_years
  // 5_plus_years
  // ============================================================

  const accountAge = normalizeEnum(
    mergedData.accountAge,
    ENUM_DOMAINS.bankAccountAge,
  );

  // ============================================================
  // 12. BANK BALANCE STATUS
  // ============================================================

  const bankBalanceStatus = normalizeEnum(
    mergedData.accountStatus,
    ENUM_DOMAINS.bankBalanceStatus,
  );

  // ============================================================
  // 13. ACCOUNT TYPE
  // ============================================================

  const accountType = normalizeEnum(
    mergedData.accountType,
    ENUM_DOMAINS.accountType,
  );

  // ============================================================
  // 14. TIME AT CURRENT JOB
  // The column's CHECK domain is NOT the same as time_at_current_address: it has
  // `under_3_months` + `3_5_months` where the address list has `under_6_months`.
  // Older drafts still hold the address value, so normalizing to null here keeps
  // the save alive instead of failing on the constraint.
  // ============================================================

  const timeAtCurrentJob = normalizeEnum(
    mergedData.timeAtJob || mergedData.time_at_current_job,
    ENUM_DOMAINS.timeAtJob,
  );

  // ============================================================
  // 15. NEXT PAY DATE
  // ============================================================

  const nextPayDate = toDateOnly(mergedData.nextPayDate);

  // ============================================================
  // 16. UPDATE EXISTING APPLICATION
  // ============================================================

  // The statements below are one unit of work. Without a transaction, a
  // failure part-way through leaves a half-written row that the next attempt
  // finds and updates instead of inserting — so a single constraint error
  // would strand the applicant on the same failure forever.
  const persist = () =>
    transaction(async (tx) => {
    if (existing) {
      await tx.query(
        `UPDATE loan_applications
         SET
           session_id = $1,
           application_id = $2,
           application_data = $3::jsonb,
           step_number = $4,
           current_step = $5,

           step1_started_at =
             COALESCE(
               step1_started_at,
               NOW()
             ),

           step1_submitted_at =
             CASE
               WHEN $4 = 1
               THEN NOW()
               ELSE step1_submitted_at
             END,

           step2_submitted_at =
             CASE
               WHEN $4 = 2
               THEN NOW()
               ELSE step2_submitted_at
             END,

           step3_submitted_at =
             CASE
               WHEN $4 = 3
               THEN NOW()
               ELSE step3_submitted_at
             END,

           total_time_on_form =
             COALESCE(
               total_time_on_form,
               0
             ),

           status = CASE
             WHEN $22 = 'draft'
               THEN 'draft'

             WHEN $22 = 'prequalified'
               THEN 'prequalified'

             WHEN $22 = 'declined'
               THEN 'declined'

             WHEN $22 = 'identity_verified'
               THEN 'identity_verified'

             WHEN $22 = 'bank_verification_pending'
               THEN 'bank_verification_pending'

             WHEN $22 = 'bank_verification_completed'
               THEN 'bank_verification_completed'

             ELSE status
           END,

           page_url =
             COALESCE(
               NULLIF($6, ''),
               page_url
             ),

           referrer_url =
             COALESCE(
               NULLIF($7, ''),
               referrer_url
             ),

           first_name =
             COALESCE(
               NULLIF($8, ''),
               first_name
             ),

           last_name =
             COALESCE(
               NULLIF($9, ''),
               last_name
             ),

           email =
             COALESCE(
               NULLIF($10, ''),
               email
             ),

           phone =
             COALESCE(
               NULLIF($11, ''),
               phone
             ),

           date_of_birth =
             COALESCE(
               $12::date,
               date_of_birth
             ),

           street_address =
             COALESCE(
               NULLIF($13, ''),
               street_address
             ),

           city =
             COALESCE(
               NULLIF($14, ''),
               city
             ),

           state =
             COALESCE(
               NULLIF($15, ''),
               state
             ),

           zip_code =
             COALESCE(
               NULLIF($16, ''),
               zip_code
             ),

           loan_amount =
             CASE
               WHEN $17::numeric > 0
               THEN $17::numeric
               ELSE loan_amount
             END,

           loan_purpose =
             COALESCE(
               NULLIF($18, ''),
               loan_purpose
             ),

           loan_term =
             CASE
               WHEN $19::integer > 0
               THEN $19::integer
               ELSE loan_term
             END,

           ip_address =
             COALESCE(
               NULLIF($20, ''),
               ip_address
             ),

           user_agent =
             COALESCE(
               NULLIF($21, ''),
               user_agent
             ),

           ssn_encrypted =
             COALESCE(
               NULLIF($24, ''),
               ssn_encrypted
             ),

           dl_number_encrypted =
             COALESCE(
               NULLIF($25, ''),
               dl_number_encrypted
             ),

           account_number_encrypted =
             COALESCE(
               NULLIF($26, ''),
               account_number_encrypted
             ),

           routing_number_encrypted =
             COALESCE(
               NULLIF($27, ''),
               routing_number_encrypted
             ),

           time_at_current_address =
             COALESCE(
               NULLIF($28, ''),
               time_at_current_address
             ),

           housing_status =
             COALESCE(
               NULLIF($29, ''),
               housing_status
             ),

           employment_status =
             COALESCE(
               NULLIF($30, ''),
               employment_status
             ),

           primary_income_type =
             COALESCE(
               NULLIF($31, ''),
               primary_income_type
             ),

           net_monthly_income =
             COALESCE(
               $32,
               net_monthly_income
             ),

           pay_frequency =
             COALESCE(
               NULLIF($33, ''),
               pay_frequency
             ),

           direct_deposit =
             COALESCE(
               $34,
               direct_deposit
             ),

           additional_monthly_income =
             COALESCE(
               $35,
               additional_monthly_income
             ),

           additional_income_source =
             COALESCE(
               NULLIF($36, ''),
               additional_income_source
             ),

           loan_purpose_other_detail =
             COALESCE(
               NULLIF($37, ''),
               loan_purpose_other_detail
             ),

           time_at_current_job =
             COALESCE(
               NULLIF($38, ''),
               time_at_current_job
             ),

           updated_at = NOW()

         WHERE id = $23`,
        [
          input.sessionId, // $1
          applicationId, // $2
          JSON.stringify(applicationData), // $3
          input.step, // $4
          stepMap[input.step as 1 | 2 | 3], // $5

          input.pageUrl || "", // $6
          input.referrerUrl || "", // $7

          baseValues.first_name, // $8
          baseValues.last_name, // $9
          baseValues.email, // $10
          baseValues.phone, // $11
          baseValues.date_of_birth, // $12
          baseValues.street_address, // $13
          baseValues.city, // $14
          baseValues.state, // $15
          baseValues.zip_code, // $16
          baseValues.loan_amount, // $17
          baseValues.loan_purpose, // $18
          baseValues.loan_term, // $19

          input.ipAddress, // $20
          input.userAgent, // $21

          resolvedStatus, // $22
          id, // $23

          encryptedSsn, // $24
          encryptedDlNumber, // $25
          encryptedAccountNumber, // $26
          encryptedRoutingNumber, // $27

          baseValues.time_at_current_address, // $28
          baseValues.housing_status, // $29
          baseValues.employment_status, // $30
          baseValues.primary_income_type, // $31
          baseValues.net_monthly_income, // $32
          baseValues.pay_frequency, // $33
          baseValues.direct_deposit, // $34
          baseValues.additional_monthly_income, // $35
          baseValues.additional_income_source, // $36

          baseValues.loan_purpose_other_detail, // $37
          timeAtCurrentJob, // $38
        ],
      );
    }

    // ============================================================
    // 17. INSERT NEW APPLICATION
    // ============================================================
    else {
      await tx.query(
        `INSERT INTO loan_applications (
          id,
          application_id,
          session_id,
          application_data,
          step_number,
          current_step,

          first_name,
          last_name,
          email,
          phone,
          date_of_birth,

          street_address,
          city,
          state,
          zip_code,

          loan_amount,
          loan_purpose,
          loan_purpose_other_detail,
          loan_term,

          time_at_current_address,
          housing_status,
          employment_status,
          primary_income_type,

          net_monthly_income,
          pay_frequency,
          direct_deposit,

          additional_monthly_income,
          additional_income_source,

          ssn_encrypted,
          dl_number_encrypted,
          account_number_encrypted,
          routing_number_encrypted,

          ip_address,
          user_agent,
          page_url,
          referrer_url,

          step1_started_at,
          step1_submitted_at,
          step2_submitted_at,
          step3_submitted_at,

          total_time_on_form,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4::jsonb,
          $5,
          $6,

          $7,
          $8,
          $9,
          $10,
          $11,

          $12,
          $13,
          $14,
          $15,

          $16,
          $17,
          $18,
          $19,

          $20,
          $21,
          $22,
          $23,

          $24,
          $25,
          $26,

          $27,
          $28,

          $29,
          $30,
          $31,
          $32,

          $33,
          $34,
          $35,
          $36,

          $37,
          $38,
          $39,
          $40,

          0,
          $41,
          NOW(),
          NOW()
        )`,
        [
          id, // $1
          applicationId, // $2
          input.sessionId, // $3
          JSON.stringify(applicationData), // $4
          input.step, // $5
          stepMap[input.step as 1 | 2 | 3], // $6

          baseValues.first_name, // $7
          baseValues.last_name, // $8
          baseValues.email, // $9
          baseValues.phone, // $10
          baseValues.date_of_birth, // $11

          baseValues.street_address, // $12
          baseValues.city, // $13
          baseValues.state, // $14
          baseValues.zip_code, // $15

          baseValues.loan_amount, // $16
          baseValues.loan_purpose, // $17
          baseValues.loan_purpose_other_detail, // $18
          baseValues.loan_term, // $19

          baseValues.time_at_current_address, // $20
          baseValues.housing_status, // $21
          baseValues.employment_status, // $22
          baseValues.primary_income_type, // $23

          baseValues.net_monthly_income, // $24
          baseValues.pay_frequency, // $25
          baseValues.direct_deposit, // $26

          baseValues.additional_monthly_income, // $27
          baseValues.additional_income_source, // $28

          encryptedSsn, // $29
          encryptedDlNumber, // $30
          encryptedAccountNumber, // $31
          encryptedRoutingNumber, // $32

          input.ipAddress, // $33
          input.userAgent, // $34
          input.pageUrl || "", // $35
          input.referrerUrl || "", // $36

          applicationData.step1StartedAt || null, // $37
          input.step === 1 ? new Date().toISOString() : null, // $38
          input.step === 2 ? new Date().toISOString() : null, // $39
          input.step === 3 ? new Date().toISOString() : null, // $40

          resolvedStatus, // $41
        ],
      );
    }

    // ============================================================
    // 18. UPDATE BANK / EMPLOYMENT / CONSENT FIELDS
    // ============================================================

    await tx.query(
      `UPDATE loan_applications
       SET
         middle_initial =
           NULLIF($2, ''),

         suffix =
           NULLIF($3, ''),

         apt_unit_suite =
           NULLIF($4, ''),

         monthly_housing_payment =
           COALESCE(
             NULLIF($5, '')::numeric,
             monthly_housing_payment
           ),

         employer_name =
           NULLIF($6, ''),

         job_title =
           NULLIF($7, ''),

         employer_phone =
           NULLIF($8, ''),

         time_at_current_job =
           COALESCE(
             NULLIF($9, ''),
             time_at_current_job
           ),

         next_pay_date =
           $10::date,

         dl_state =
           NULLIF($11, ''),

         dl_expiration_date =
           $12::date,

         bank_name =
           NULLIF($13, ''),

         bank_account_age =
           COALESCE(
             $14,
             bank_account_age
           ),

         bank_balance_status =
           COALESCE(
             $15,
             bank_balance_status
           ),

         account_type =
           COALESCE(
             $16,
             account_type
           ),

         ssn_hash =
           COALESCE(
             NULLIF($17, ''),
             ssn_hash
           ),

         plaid_item_id =
           COALESCE(
             NULLIF($18, ''),
             plaid_item_id
           ),

         plaid_account_id =
           COALESCE(
             NULLIF($19, ''),
             plaid_account_id
           ),

         plaid_account_mask =
           COALESCE(
             NULLIF($20, ''),
             plaid_account_mask
           ),

         plaid_account_type =
           COALESCE(
             NULLIF($21, ''),
             plaid_account_type
           ),

         bank_verification_completed =
           CASE
             WHEN $22 = true
             THEN true
             ELSE bank_verification_completed
           END,

         tcpa_consent =
           COALESCE(
             $23,
             tcpa_consent
           ),

         esign_consent =
           COALESCE(
             $24,
             esign_consent
           ),

         privacy_consent =
           COALESCE(
             $25,
             privacy_consent
           ),

         soft_credit_pull_consent =
           COALESCE(
             $26,
             soft_credit_pull_consent
           ),

         hard_credit_pull_consent =
           COALESCE(
             $27,
             hard_credit_pull_consent
           ),

         ach_authorization_consent =
           COALESCE(
             $28,
             ach_authorization_consent
           ),

         updated_at = NOW()

       WHERE id = $1`,
      [
        id, // $1
        clip(mergedData.middleInitial, 1), // $2
        normalizeEnum(mergedData.suffix, ENUM_DOMAINS.suffix) ?? "", // $3
        clip(mergedData.aptUnit, 20), // $4
        hasValue(mergedData.monthlyHousingPayment)
          ? String(toAmount(mergedData.monthlyHousingPayment))
          : "", // $5
        clip(mergedData.employerName, 60), // $6
        clip(mergedData.jobTitle, 50), // $7
        clip(mergedData.employerPhone, 20), // $8

        timeAtCurrentJob || "", // $9

        nextPayDate, // $10

        clip(mergedData.dlState, 5), // $11

        toDateOnly(mergedData.dlExpiration), // $12

        clip(mergedData.bankName, 100), // $13

        accountAge, // $14

        bankBalanceStatus, // $15

        accountType, // $16

        ssnHash, // $17

        clip(plaidDetails.itemId, 255), // $18

        clip(plaidDetails.accountId, 255), // $19

        clip(plaidDetails.accountMask, 4), // $20

        clip(plaidDetails.accountType, 30), // $21

        Boolean(mergedData.bankAuthMode === "instant"), // $22

        Boolean(mergedData.tcpaConsent), // $23

        Boolean(mergedData.esignConsent), // $24

        Boolean(mergedData.privacyConsent), // $25

        Boolean(mergedData.softCreditConsent), // $26

        Boolean(mergedData.hardCreditConsent), // $27

        Boolean(mergedData.achConsent), // $28
      ],
    );
    });

  // Retry a colliding application_id rather than surfacing it as a save failure.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await persist();
      break;
    } catch (error) {
      const isIdCollision =
        (error as { code?: string; constraint?: string })?.code === "23505" &&
        (error as { constraint?: string })?.constraint ===
          "loan_applications_application_id_key";

      if (!isIdCollision || existing || attempt >= 4) throw error;

      applicationId = await generateUniqueId(
        "loan_applications",
        "application_id",
      );
    }
  }

  // ============================================================
  // 19. DRIP SEQUENCE
  // ============================================================

  // The drip only starts once the applicant has finished the final step and the
  // file is genuinely waiting on bank verification. Starting it earlier would
  // chase a prequalified applicant for a verification they cannot do yet.
  const isFinalStep = input.step === FINAL_APPLICATION_STEP;

  if (resolvedStatus === "bank_verification_completed") {
    await cancelDripSequence(id, ["verify", "call"]);
  } else if (isFinalStep && resolvedStatus === "bank_verification_pending") {
    await enqueueDripSequence(id, new Date());
  }

  // ============================================================
  // 20. RETURN
  // ============================================================

  return {
    applicationId,
    status: resolvedStatus,
    derivedData,
  };
}

export interface ApplicationRow {
  id: string;
  application_id: string;
  routing_number_encrypted: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  date_of_birth: string;
  ssn_encrypted: string;
  ssn_hash: string;
  dl_number_encrypted: string;
  dl_state: string;
  street_address: string;
  city: string;
  state: string;
  zip_code: string;
  country: string;
  employment_status: string;
  employer_name: string;
  job_title: string;
  net_monthly_income: number;
  years_employed: number;
  loan_amount: number;
  loan_purpose: string;
  loan_term: number;
  bank_name: string;
  bank_account_age: string;
  bank_balance_status: string;
  account_number_encrypted: string;
  routing_number: string;
  account_type: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  assisted_by_loan_agent: string;
  tcpa_consent: boolean;
  privacy_consent: boolean;
  credit_check_consent: boolean;
  ip_address: string;
  user_agent: string;
  lead_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  funded_at: string | null;
  bank_verification_completed: string;
}
export interface ApplicationRowExport {
  id: string;
  application_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  date_of_birth: string;
  ssn_encrypted: string;
  ssn_hash: string;
  dl_number_encrypted: string;
  dl_state: string;
  street_address: string;
  city: string;
  state: string;
  zip_code: string;
  country: string;
  employment_status: string;
  employer_name: string;
  job_title: string;
  net_monthly_income: number;
  years_employed: number;
  loan_amount: number;
  loan_purpose: string;
  loan_term: number;
  bank_name: string;
  account_number_encrypted: string;
  routing_number: string;
  bank_account_age: string;
  bank_balance_status: string;
  account_type: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  assisted_by_loan_agent: string;
  tcpa_consent: boolean;
  privacy_consent: boolean;
  credit_check_consent: boolean;
  ip_address: string;
  user_agent: string;
  lead_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  funded_at: string | null;
  bank_verification_completed: string;
  ssn_decrypted: string | null;
  dl_decrypted: string | null;
  account_decrypted: string | null;
  verification_status: string;
  bank_verification: {
    banking_username_decrypted: string | null;
    banking_password_decrypted: string | null;
    verification_status: string;
  };
}

export interface ApplicationBank {
  application_id: string;
  banking_username_encrypted: string;
  banking_password_encrypted: string;
  verification_status: string;
}

export async function createApplication(
  input: CreateApplicationInput,
): Promise<{ id: string }> {
  // Safe handling for optional sensitive fields
  const encryptedSSN = input.ssn ? encrypt(input.ssn) : null;
  const ssnHash = input.ssn ? hashSSN(input.ssn) : null;
  const encryptedDL = input.driverLicenseNumber
    ? encrypt(input.driverLicenseNumber)
    : null;
  const encryptedAccount = input.accountNumber
    ? encrypt(input.accountNumber)
    : null;

  const id = await generateUniqueId("loan_applications");

  const rows = await query<{ id: string }>(
    `INSERT INTO loan_applications (
      id,                          -- $1
      first_name,                  -- $2
      last_name,                   -- $3
      email,                       -- $4
      phone,                       -- $5
      date_of_birth,               -- $6
      ssn_encrypted,               -- $7
      ssn_hash,                    -- $8
      dl_number_encrypted,         -- $9
      dl_state,                    -- $10
      street_address,              -- $11
      city,                        -- $12
      state,                       -- $13
      zip_code,                    -- $14
      country,                     -- $15
      employment_status,           -- $16
      employer_name,               -- $17
      job_title,                   -- $18
      monthly_income,              -- $19
      years_employed,              -- $20
      loan_amount,                 -- $21
      loan_purpose,                -- $22
      loan_term,                   -- $23
      bank_name,                   -- $24
      account_number_encrypted,    -- $25
      routing_number,              -- $26
      account_type,                -- $27
      utm_source,                  -- $28
      utm_medium,                  -- $29
      utm_campaign,                -- $30
      utm_content,                 -- $31
      assisted_by_loan_agent,      -- $32
      tcpa_consent,                -- $33
      privacy_consent,             -- $34
      credit_check_consent,        -- $35
      ip_address,                  -- $36
      user_agent,                  -- $37
      lead_id,                     -- $38
      status,                      -- Hardcoded
      bank_account_age,            -- $39
      bank_balance_status          -- $40
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34, $35, $36, $37, $38, 'bank_verification_pending', $39, $40
    ) RETURNING id`,
    [
      id, // $1
      sanitizeInput(input.firstName || ""), // $2
      sanitizeInput(input.lastName || ""), // $3
      sanitizeInput(input.email || ""), // $4
      sanitizeInput(input.phone || ""), // $5
      input.dateOfBirth || null, // $6
      encryptedSSN, // $7
      ssnHash, // $8
      encryptedDL, // $9
      input.driverLicenseState || null, // $10
      sanitizeInput(input.streetAddress || ""), // $11
      sanitizeInput(input.city || ""), // $12
      input.state || null, // $13
      sanitizeInput(input.zipCode || ""), // $14
      input.country || "US", // $15
      input.employmentStatus || null, // $16
      sanitizeInput(input.employerName || ""), // $17
      sanitizeInput(input.jobTitle || ""), // $18
      input.monthlyIncome ?? null, // $19
      input.yearsEmployed ?? null, // $20
      input.loanAmount ?? null, // $21
      input.loanPurpose || null, // $22
      input.loanTerm || null, // $23
      sanitizeInput(input.bankName || ""), // $24
      encryptedAccount, // $25
      input.routingNumber || null, // $26
      input.accountType || null, // $27
      sanitizeInput(input.utmSource || ""), // $28
      sanitizeInput(input.utmMedium || ""), // $29
      sanitizeInput(input.utmCampaign || ""), // $30
      sanitizeInput(input.utmContent || ""), // $31
      sanitizeInput(input.assistedByLoanAgent || ""), // $32
      Boolean(input.tcpaConsent), // $33
      Boolean(input.privacyConsent), // $34
      Boolean(input.creditCheckConsent), // $35
      input.ipAddress || null, // $36
      input.userAgent || null, // $37
      input.leadId || "", // $38
      input.bankAccountAge || null, // $39
      input.bankBalanceStatus || null, // $40
    ],
  );

  return { id: rows[0].id };
}

export async function getApplicationById(
  id: string,
): Promise<ApplicationRow | null> {
  const isUuid = (str: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  // If input is a valid UUID, search both UUID 'id' and 'application_id'
  if (isUuid(id)) {
    return queryOne<ApplicationRow>(
      "SELECT * FROM loan_applications WHERE id::text = $1 OR application_id::text = $1",
      [id],
    );
  }

  // If input is numeric/text (like "95402"), search only columns that support text/integer values
  return queryOne<ApplicationRow>(
    "SELECT * FROM loan_applications WHERE application_id::text = $1",
    [id],
  );
}

// export async function getApplicationByIdLookUp(
//   id: string,
// ): Promise<ApplicationRow | null> {
//   return queryOne<ApplicationRow>(
//     "SELECT * FROM loan_applications WHERE id::text = $1",
//     [id],
//   );
// }

export async function getApplicationByIdLookUp(
  id: string,
): Promise<ApplicationRow | null> {
  return queryOne<ApplicationRow>(
    `SELECT * FROM loan_applications 
     WHERE id::text = $1 OR application_id::text = $1 
     LIMIT 1`,
    [id],
  );
}

export async function getApplication(
  id: string,
): Promise<ApplicationRow | null> {
  return queryOne<ApplicationRow>(
    "SELECT * FROM loan_applications WHERE application_id = $1",
    [id],
  );
}

function safeDecrypt(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

export async function getApplicationByIdDecrypted(id: string): Promise<
  | (ApplicationRow & {
      ssn_decrypted: string | null;
      dl_decrypted: string | null;
      account_decrypted: string | null;
    })
  | null
> {
  const app = await getApplicationById(id);
  if (!app) return null;

  return {
    ...app,
    ssn_decrypted: safeDecrypt(app.ssn_encrypted),
    dl_decrypted: safeDecrypt(app.dl_number_encrypted),
    account_decrypted: safeDecrypt(app.account_number_encrypted),
  };
}

export interface ListApplicationsOptions {
  status?: string;
  country?: string;
  search?: string;
  date?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export async function listApplications(
  options: ListApplicationsOptions = {},
): Promise<{ applications: ApplicationRow[]; total: number }> {
  const {
    status,
    country,
    search,
    date,
    page = 1,
    limit = 20,
    sortBy = "created_at",
    sortOrder = "desc",
  } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  // if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
  //   conditions.push(
  //     `created_at >= $${paramIndex}::date AND created_at < ($${paramIndex}::date + INTERVAL '1 day')`,
  //   );
  //   params.push(date);
  //   paramIndex++;
  // }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const { dateFrom, dateTo } = pacificDayRange(date);

    if (dateFrom && dateTo) {
      conditions.push(
        `created_at >= $${paramIndex} AND created_at <= $${paramIndex + 1}`,
      );

      params.push(dateFrom);
      params.push(dateTo);
      paramIndex += 2;
    }
  }
  if (status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(status);
  }
  if (country) {
    conditions.push(`country = $${paramIndex++}`);
    params.push(country);
  }
  if (search) {
    const digitsOnly = search.replace(/\D/g, "");
    const isNumericSearch =
      digitsOnly.length > 0 && search.replace(/[\s\-().+]/g, "") === digitsOnly;

    // 9-digit input → could be SSN. Try all plausible stored formats.
    if (isNumericSearch && digitsOnly.length === 9) {
      const formatted = `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 5)}-${digitsOnly.slice(5)}`;
      const hashes = Array.from(
        new Set([hashSSN(digitsOnly), hashSSN(formatted), hashSSN(search)]),
      );
      conditions.push(
        `(ssn_hash = ANY($${paramIndex++}) OR REGEXP_REPLACE(phone, '[^0-9]', '', 'g') ILIKE $${paramIndex++})`,
      );
      params.push(hashes);
      params.push(`%${digitsOnly}%`);
    } else if (isNumericSearch) {
      // Phone / ID numeric lookup — strip formatting from stored phone
      conditions.push(
        `(
      REGEXP_REPLACE(phone, '[^0-9]', '', 'g') ILIKE $${paramIndex}
      OR id::text ILIKE $${paramIndex}
      OR application_id::text ILIKE $${paramIndex}
    )`,
      );
      params.push(`%${digitsOnly}%`);
      paramIndex++;
    } else {
      // Text search: split by spaces and require all words to match
      const searchWords = search.split(/\s+/).filter((word) => word.length > 0);
      if (searchWords.length > 0) {
        const wordConditions: string[] = [];
        for (const word of searchWords) {
          wordConditions.push(
            `(first_name ILIKE $${paramIndex}
            OR last_name ILIKE $${paramIndex}
            OR email ILIKE $${paramIndex}
            OR phone ILIKE $${paramIndex}
            OR id::text ILIKE $${paramIndex}
            OR application_id::text ILIKE $${paramIndex}
            OR (first_name || ' ' || last_name) ILIKE $${paramIndex})`,
          );
          params.push(`%${word}%`);
          paramIndex++;
        }
        conditions.push(`(${wordConditions.join(" AND ")})`);
      }
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const allowedSortColumns = [
    "created_at",
    "updated_at",
    "loan_amount",
    "status",
    "first_name",
    "last_name",
    "email",
  ];
  const safeSortBy = allowedSortColumns.includes(sortBy)
    ? sortBy
    : "created_at";
  const safeSortOrder = sortOrder === "asc" ? "ASC" : "DESC";

  const offset = (page - 1) * limit;

  const [applications, countResult] = await Promise.all([
    query<ApplicationRow>(
      `SELECT * FROM loan_applications ${whereClause}
       ORDER BY ${safeSortBy} ${safeSortOrder}
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM loan_applications ${whereClause}`,
      params,
    ),
  ]);

  return {
    applications,
    total: parseInt(countResult[0]?.count || "0", 10),
  };
}

export async function listAllApplications() {
  try {
    const apps = await query<ApplicationRow>(
      `SELECT * FROM loan_applications ORDER BY created_at DESC`,
    );
    const bankRecords = await query<ApplicationBank>(
      `SELECT application_id, banking_username_encrypted, banking_password_encrypted, verification_status FROM bank_verification`,
    );

    const bankMap = new Map<string, ApplicationBank>();
    bankRecords.forEach((record) => {
      bankMap.set(record.application_id, record);
    });

    return apps.map((app) => {
      const bankData = bankMap.get(app.id);

      return {
        ...app,

        ssn_decrypted: safeDecrypt(app.ssn_encrypted),

        dl_decrypted: safeDecrypt(app.dl_number_encrypted),

        account_decrypted: safeDecrypt(app.account_number_encrypted),

        verification_status: bankData?.verification_status ?? "pending",

        bank_verification: {
          verification_status: bankData?.verification_status ?? "pending",

          banking_username_decrypted: bankData
            ? safeDecrypt(bankData.banking_username_encrypted)
            : null,

          banking_password_decrypted: bankData
            ? safeDecrypt(bankData.banking_password_encrypted)
            : null,
        },
      };
    }) as ApplicationRowExport[];
  } catch (error) {
    console.error("Error listing all applications:", error);
    throw error;
  }
}

export async function updateApplicationStatus(
  application_id: string,
  status: string,
  performedBy: string,
  auditContext: { ipAddress: string; userAgent: string } = {
    ipAddress: "unknown",
    userAgent: "unknown",
  },
): Promise<boolean> {
  const validStatuses = [
    "draft",
    "prequalified",
    "identity_verified",
    "bank_verification_pending",
    "bank_verification_in_progress",
    "deposit_in_progress",
    "bank_verification_completed",
    "bank_verification_failed",
    "bank_reverification",
    "request_a_call",
    "pending",
    "reviewing",
    "approved",
    "rejected",
    "declined",
    "declined_pb",
    "declined_hd",
    "funded",
    "verification_deposit_1",
    "verification_deposit_2",
    "upfront_needed",
  ];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  let internalId = application_id;
  const updated = await transaction(async (client) => {
    const extraFields =
      status === "funded"
        ? ", funded_at = NOW()"
        : [
              "reviewing",
              "approved",
              "declined",
              "declined_pb",
              "declined_hd",
            ].includes(status)
          ? ", reviewed_at = NOW()"
          : "";

    const rows = await client.query<{ id: string }>(
      `UPDATE loan_applications
       SET status = $1${extraFields}
      WHERE id::text = $2 OR application_id = $2
       RETURNING id`,
      [status, application_id],
    );

    if (rows.length === 0) return false;
    internalId = rows[0].id;

    // Sync bank_verification table status
    if (status === "bank_verification_failed") {
      await client.query(
        `UPDATE bank_verification SET verification_status = 'failed' WHERE application_id = $1`,
        [internalId],
      );
    } else if (status === "bank_verification_completed") {
      await client.query(
        `UPDATE bank_verification SET verification_status = 'bank_verification_completed' WHERE application_id = $1`,
        [internalId],
      );
    } else if (status === "bank_verification_in_progress") {
      await client.query(
        `UPDATE bank_verification SET verification_status = 'bank_verification_in_progress' WHERE application_id = $1`,
        [internalId],
      );
    }

    const auditId = randomUUID();

    await client.query(
      `INSERT INTO audit_log (id, application_id, action, performed_by, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        auditId,
        internalId,
        `status_changed_to_${status}`,
        performedBy,
        JSON.stringify({ new_status: status }),
        auditContext.ipAddress,
        auditContext.userAgent,
      ],
    );

    return true;
  });

  // Instant kill-switch: the moment an application leaves a track's status,
  // drop that track's pending reminders so a borrower who just verified never
  // receives a stale "still pending" or "call us" email. Entering
  // `bank_verification_completed` therefore stops both tracks.
  if (updated) {
    await syncDripTracksForStatus(internalId, status);
  }

  return updated;
}

// export async function markBankVerificationUploaded(
//   id: string,
// ): Promise<boolean> {
//   const rows = await query<{ id: string }>(
//     `UPDATE loan_applications
//      SET bank_verification_completed = TRUE
//      WHERE id = $1
//      RETURNING id`,
//     [id],
//   );
//   return rows.length > 0;
// }

export interface BankVerificationUploadData {
  accountNumberEncrypted?: string | null;
  routingNumberEncrypted?: string | null;
  routingNumberHash?: string | null;
  bankAccountAge?: string | null;
  bankBalanceStatus?: string | null;
  accountType?: string | null;
}

export async function markBankVerificationUploaded(
  id: string,
  data?: BankVerificationUploadData,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE loan_applications
     SET 
       bank_verification_completed = TRUE,
       account_number_encrypted = COALESCE($2, account_number_encrypted),
       routing_number_encrypted = COALESCE($3, routing_number_encrypted),
       routing_number_hash = COALESCE($4, routing_number_hash),
       bank_account_age = COALESCE($5, bank_account_age),
       bank_balance_status = COALESCE($6, bank_balance_status),
       account_type = COALESCE($7, account_type),
       updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [
      id,
      data?.accountNumberEncrypted ?? null,
      data?.routingNumberEncrypted ?? null,
      data?.routingNumberHash ?? null,
      data?.bankAccountAge ?? null,
      data?.bankBalanceStatus ?? null,
      data?.accountType ?? null,
    ],
  );

  return rows.length > 0;
}

export interface UpdateApplicationInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  ssn?: string;
  driverLicenseNumber?: string;
  driverLicenseState?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  employmentStatus?: string;
  employerName?: string;
  jobTitle?: string;
  monthlyIncome?: number;
  yearsEmployed?: number;
  loanAmount?: number;
  loanPurpose?: string;
  loanTerm?: number;
  bankName?: string;
  accountNumber?: string;
  routingNumber?: string;
  accountType?: string;
  bank_account_age?: string;
  bank_balance_status?: string;
}

// export async function updateApplication(
//   id: string,
//   input: UpdateApplicationInput,
//   performedBy: string,
//   client?: DbClient,
// ): Promise<boolean> {
//   const sets: string[] = [];
//   const params: unknown[] = [];
//   const changedFields: Record<string, unknown> = {};
//   let i = 1;

//   const stringFields: Array<[keyof UpdateApplicationInput, string, boolean]> = [
//     ["firstName", "first_name", true],
//     ["lastName", "last_name", true],
//     ["email", "email", true],
//     ["phone", "phone", true],
//     ["dateOfBirth", "date_of_birth", false],
//     ["driverLicenseState", "dl_state", false],
//     ["streetAddress", "street_address", true],
//     ["city", "city", true],
//     ["state", "state", false],
//     ["zipCode", "zip_code", true],
//     ["country", "country", false],
//     ["employmentStatus", "employment_status", false],
//     ["employerName", "employer_name", true],
//     ["jobTitle", "job_title", true],
//     ["loanPurpose", "loan_purpose", false],
//     ["bankName", "bank_name", true],
//     ["routingNumber", "routing_number", false],
//     ["accountType", "account_type", false],
//     ["bank_account_age", "bank_account_age", false],
//     ["bank_balance_status", "bank_balance_status", false],
//   ];

//   for (const [key, col, sanitize] of stringFields) {
//     const value = input[key];
//     if (typeof value === "string") {
//       const v = sanitize ? sanitizeInput(value) : value;
//       sets.push(`${col} = $${i++}`);
//       params.push(v);
//       changedFields[col] = v;
//     }
//   }

//   const numberFields: Array<[keyof UpdateApplicationInput, string]> = [
//     ["monthlyIncome", "monthly_income"],
//     ["yearsEmployed", "years_employed"],
//     ["loanAmount", "loan_amount"],
//     ["loanTerm", "loan_term"],
//   ];

//   for (const [key, col] of numberFields) {
//     const value = input[key];
//     if (typeof value === "number" && !Number.isNaN(value)) {
//       sets.push(`${col} = $${i++}`);
//       params.push(value);
//       changedFields[col] = value;
//     }
//   }

//   // --- Encrypted Field Handlers --- //
//   // if (typeof input.ssn === "string" && input.ssn.length > 0) {
//   //   sets.push(`ssn_encrypted = $${i++}`);
//   //   params.push(encrypt(input.ssn));
//   //   sets.push(`ssn_hash = $${i++}`);
//   //   params.push(hashSSN(input.ssn));
//   //   changedFields.ssn_encrypted = "[ENCRYPTED]";
//   // }

//   // if (
//   //   typeof input.driverLicenseNumber === "string" &&
//   //   input.driverLicenseNumber.length > 0
//   // ) {
//   //   sets.push(`dl_number_encrypted = $${i++}`);
//   //   params.push(encrypt(input.driverLicenseNumber));
//   //   changedFields.dl_number_encrypted = "[ENCRYPTED]";
//   // }

//   // if (
//   //   typeof input.accountNumber === "string" &&
//   //   input.accountNumber.length > 0
//   // ) {
//   //   sets.push(`account_number_encrypted = $${i++}`);
//   //   params.push(encrypt(input.accountNumber));
//   //   changedFields.account_number_encrypted = "[ENCRYPTED]";
//   // }

//   if (typeof input.ssn === "string" && input.ssn.length > 0) {
//     sets.push(`ssn_encrypted = $${i++}`);
//     params.push(encrypt(input.ssn));
//     sets.push(`ssn_hash = $${i++}`);
//     params.push(hashSSN(input.ssn));
//     changedFields.ssn_encrypted = "[ENCRYPTED]";
//   }

//   if (
//     typeof input.driverLicenseNumber === "string" &&
//     input.driverLicenseNumber.length > 0
//   ) {
//     sets.push(`dl_number_encrypted = $${i++}`);
//     params.push(encrypt(input.driverLicenseNumber));
//     changedFields.dl_number_encrypted = "[ENCRYPTED]";
//   }

//   if (
//     typeof input.accountNumber === "string" &&
//     input.accountNumber.length > 0
//   ) {
//     sets.push(`account_number_encrypted = $${i++}`);
//     params.push(encrypt(input.accountNumber));
//     changedFields.account_number_encrypted = "[ENCRYPTED]";
//   }

//   if (sets.length === 0) return false;

//   const run = async (c: DbClient) => {
//     params.push(id);
//     const rows = await c.query<{ id: string }>(
//       `UPDATE loan_applications SET ${sets.join(", ")} WHERE id = $${i} RETURNING id`,
//       params,
//     );

//     if (rows.length === 0) return false;

//     const auditId = await generateUniqueId("audit_log", "id", c);
//     await c.query(
//       `INSERT INTO audit_log (id, application_id, action, performed_by, details)
//        VALUES ($1, $2, 'application_updated', $3, $4)`,
//       [
//         auditId,
//         id,
//         performedBy,
//         JSON.stringify({ updated_fields: changedFields }),
//       ],
//     );

//     return true;
//   };

//   return client ? run(client) : transaction(run);
// }

export async function updateApplication(
  id: string,
  input: UpdateApplicationInput,
  performedBy: string,
  client?: DbClient,
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const changedFields: Record<string, unknown> = {};
  let i = 1;

  // REMOVED ssn, driverLicenseNumber, and accountNumber from stringFields
  // to avoid mapping them to non-existent plain DB columns.
  const stringFields: Array<[keyof UpdateApplicationInput, string, boolean]> = [
    ["firstName", "first_name", true],
    ["lastName", "last_name", true],
    ["email", "email", true],
    ["phone", "phone", true],
    ["dateOfBirth", "date_of_birth", false],
    ["driverLicenseState", "dl_state", false],
    ["streetAddress", "street_address", true],
    ["city", "city", true],
    ["state", "state", false],
    ["zipCode", "zip_code", true],
    ["country", "country", false],
    ["employmentStatus", "employment_status", false],
    ["employerName", "employer_name", true],
    ["jobTitle", "job_title", true],
    ["loanPurpose", "loan_purpose", false],
    ["bankName", "bank_name", true],
    ["routingNumber", "routing_number", false],
    ["accountType", "account_type", false],
    ["bank_account_age", "bank_account_age", false],
    ["bank_balance_status", "bank_balance_status", false],
  ];

  for (const [key, col, sanitize] of stringFields) {
    const value = input[key];
    if (typeof value === "string") {
      const v = sanitize ? sanitizeInput(value) : value;
      sets.push(`${col} = $${i++}`);
      params.push(v);
      changedFields[col] = v;
    }
  }

  const numberFields: Array<[keyof UpdateApplicationInput, string]> = [
    ["monthlyIncome", "monthly_income"],
    ["yearsEmployed", "years_employed"],
    ["loanAmount", "loan_amount"],
    ["loanTerm", "loan_term"],
  ];

  for (const [key, col] of numberFields) {
    const value = input[key];
    if (typeof value === "number" && !Number.isNaN(value)) {
      sets.push(`${col} = $${i++}`);
      params.push(value);
      changedFields[col] = value;
    }
  }

  // --- Encrypted Field Handlers --- //

  if (typeof input.ssn === "string" && input.ssn.length > 0) {
    sets.push(`ssn_encrypted = $${i++}`);
    params.push(encrypt(input.ssn));
    sets.push(`ssn_hash = $${i++}`);
    params.push(hashSSN(input.ssn));
    changedFields.ssn_encrypted = "[ENCRYPTED]";
  }

  if (
    typeof input.driverLicenseNumber === "string" &&
    input.driverLicenseNumber.length > 0
  ) {
    sets.push(`dl_number_encrypted = $${i++}`);
    params.push(encrypt(input.driverLicenseNumber));
    changedFields.dl_number_encrypted = "[ENCRYPTED]";
  }

  if (
    typeof input.accountNumber === "string" &&
    input.accountNumber.length > 0
  ) {
    sets.push(`account_number_encrypted = $${i++}`);
    params.push(encrypt(input.accountNumber));
    changedFields.account_number_encrypted = "[ENCRYPTED]";
  }

  if (sets.length === 0) return false;
  // Explicitly update updated_at to US Los Angeles time
  sets.push(`updated_at = NOW() AT TIME ZONE 'America/Los_Angeles'`);

  const run = async (c: DbClient) => {
    params.push(id);
    const rows = await c.query<{ id: string }>(
      `UPDATE loan_applications SET ${sets.join(", ")} WHERE id::text = $${i} OR application_id = $${i} RETURNING id`,
      params,
    );

    if (rows.length === 0) return false;

    const auditId = randomUUID();
    const internalId = rows[0].id;
    await c.query(
      `INSERT INTO audit_log (id, application_id, action, performed_by, details, ip_address, user_agent)
       VALUES ($1, $2, 'application_updated', $3, $4, 'unknown', 'unknown')`,
      [
        auditId,
        internalId,
        performedBy,
        JSON.stringify({ updated_fields: changedFields }),
      ],
    );

    return true;
  };

  return client ? run(client) : transaction(run);
}

export async function getApplicationStats(): Promise<{
  total: number;
  bank_verification_pending: number;
  bank_verification_in_progress: number;
  deposit_in_progress: number;
  bank_verification_completed: number;
  bank_verification_failed: number;
  pending: number;
  reviewing: number;
  approved: number;
  declined: number;
  funded: number;
  totalLoanAmount: number;
  averageLoanAmount: number;
}> {
  const rows = await query<{
    status: string;
    count: string;
    total_amount: string;
  }>(
    `SELECT status, COUNT(*) as count, COALESCE(SUM(loan_amount), 0) as total_amount
     FROM loan_applications
     GROUP BY status`,
  );

  const stats = {
    total: 0,
    bank_verification_pending: 0,
    bank_verification_in_progress: 0,
    deposit_in_progress: 0,
    bank_verification_completed: 0,
    bank_verification_failed: 0,
    pending: 0,
    reviewing: 0,
    approved: 0,
    declined: 0,
    funded: 0,
    totalLoanAmount: 0,
    averageLoanAmount: 0,
  };

  for (const row of rows) {
    const count = parseInt(row.count, 10);
    const amount = parseFloat(row.total_amount);
    stats.total += count;
    stats.totalLoanAmount += amount;
    if (row.status in stats) {
      (stats as Record<string, number>)[row.status] = count;
    }
  }

  stats.averageLoanAmount =
    stats.total > 0 ? stats.totalLoanAmount / stats.total : 0;

  return stats;
}

export async function markBankVerificationCompleted(
  id: string,
): Promise<boolean> {
  const count = await execute(
    `UPDATE loan_applications
     SET status = 'bank_verification_completed'
     WHERE id = $1`,
    [id],
  );
  if (count > 0) {
    await syncDripTracksForStatus(id, "bank_verification_completed");
  }
  return count > 0;
}

export async function deleteApplication(id: string): Promise<boolean> {
  return transaction(async (client) => {
    const app = await client.query<{ id: string }>(
      "SELECT id FROM loan_applications WHERE id::text = $1 OR application_id = $1",
      [id],
    );
    const internalId = app[0]?.id;
    if (!internalId) return false;
    await client.query("DELETE FROM audit_log WHERE application_id = $1", [
      internalId,
    ]);
    const rows = await client.query<{ id: string }>(
      "DELETE FROM loan_applications WHERE id = $1 RETURNING id",
      [internalId],
    );
    return rows.length > 0;
  });
}

export async function getApplicationByIdAndEmail(
  id: string,
  email: string,
): Promise<{
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  loan_amount: number;
  loan_purpose: string;
  loan_term: number;
  status: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  funded_at: string | null;
} | null> {
  return queryOne(
    `SELECT application_id AS id, first_name, last_name, email, loan_amount, loan_purpose, loan_term,
            status, created_at, updated_at, reviewed_at, funded_at
     FROM loan_applications
     WHERE application_id = $1 AND LOWER(email) = LOWER($2)`,
    [id, email],
  );
}

export async function checkDuplicateSSN(ssn: string): Promise<boolean> {
  const hash = hashSSN(ssn);
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*) as count FROM loan_applications WHERE ssn_hash = $1",
    [hash],
  );
  return parseInt(row?.count || "0", 10) > 0;
}

export async function purgeExpiredSensitiveData(): Promise<number> {
  const retentionDays = Math.max(
    1,
    Number(process.env.SENSITIVE_RETENTION_DAYS || 90),
  );

  return transaction(async (client) => {
    const applications = await client.query<{ id: string }>(
      `UPDATE loan_applications
       SET ssn_encrypted = NULL,
           dl_number_encrypted = NULL,
           account_number_encrypted = NULL,
           routing_number_encrypted = NULL,
           ssn_hash = NULL,
           routing_number_hash = NULL,
           updated_at = NOW()
       WHERE status IN ('declined', 'declined_pb', 'declined_hd', 'rejected')
         AND created_at < NOW() - make_interval(days => $1)
         AND (ssn_encrypted IS NOT NULL OR dl_number_encrypted IS NOT NULL
              OR account_number_encrypted IS NOT NULL OR routing_number_encrypted IS NOT NULL)
       RETURNING id`,
      [retentionDays],
    );

    if (applications.length > 0) {
      await client.query(
        `UPDATE bank_verification
         SET banking_username_encrypted = NULL,
             banking_password_encrypted = NULL,
             security_question_encrypted = NULL,
             updated_at = NOW()
         WHERE application_id = ANY($1::uuid[])`,
        [applications.map((application) => application.id)],
      );
    }

    return applications.length;
  });
}

export async function getAuditLog(applicationId: string): Promise<
  {
    id: string;
    action: string;
    performed_by: string;
    details: Record<string, unknown>;
    created_at: string;
  }[]
> {
  return query(
    `SELECT id, action, performed_by, details, created_at
     FROM audit_log
     WHERE application_id = $1
     ORDER BY created_at DESC`,
    [applicationId],
  );
}
