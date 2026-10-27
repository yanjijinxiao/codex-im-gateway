import crypto from "node:crypto";

import QRCode from "qrcode";

import { saveScannedAccount, publicAccount, type PublicWeixinAccount } from "../weixin/accounts.js";
import { createQrLoginSession, type QrLoginUpdate, type WeixinQrLoginSession } from "../weixin/login.js";
import type { StatePaths } from "../state/paths.js";
import type { AccountManager } from "./account-manager.js";

type LoginRecord = {
  session: WeixinQrLoginSession;
  status: QrLoginUpdate["status"];
  account?: PublicWeixinAccount;
  confirmed?: Extract<QrLoginUpdate, { status: "confirmed" }>;
  saved?: ReturnType<typeof saveScannedAccount>["account"];
  polling?: Promise<{ status: QrLoginUpdate["status"]; account?: PublicWeixinAccount }>;
};

export class LoginCompletionPendingError extends Error {
  constructor(cause: unknown) { super("身份已确认，但账号保存或连接尚未完成；将继续尝试，无需重新扫码。", { cause }); }
}

export type LoginManagerOptions = {
  paths: StatePaths;
  accountManager: AccountManager;
  sessionFactory?: typeof createQrLoginSession;
  qrDataUrlFactory?: (content: string) => Promise<string>;
};

export class LoginManager {
  private readonly sessions = new Map<string, LoginRecord>();
  private readonly sessionFactory: typeof createQrLoginSession;
  private readonly qrDataUrlFactory: (content: string) => Promise<string>;

  constructor(private readonly options: LoginManagerOptions) {
    this.sessionFactory = options.sessionFactory ?? createQrLoginSession;
    this.qrDataUrlFactory = options.qrDataUrlFactory ?? ((content) => QRCode.toDataURL(content, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#111816", light: "#ffffff" }
    }));
  }

  async start(): Promise<{ id: string; qrDataUrl: string; expiresAt: string; status: "waiting" }> {
    const session = await this.sessionFactory();
    const id = crypto.randomUUID();
    const qrDataUrl = await this.qrDataUrlFactory(session.qrContent);
    this.sessions.set(id, { session, status: "waiting" });
    return {
      id,
      qrDataUrl,
      expiresAt: session.expiresAt,
      status: "waiting"
    };
  }

  async poll(id: string): Promise<{ status: QrLoginUpdate["status"]; account?: PublicWeixinAccount }> {
    const record = this.sessions.get(id);
    if (!record) {
      throw new Error(`Login session not found: ${id}`);
    }
    if (record.status === "confirmed" || record.status === "expired") {
      return { status: record.status, ...(record.account ? { account: record.account } : {}) };
    }
    if (record.polling) return record.polling;
    const work = (async () => {
      const update = record.confirmed ?? await record.session.poll();
      if (update.status === "confirmed") {
        // Cache native confirmation, but do not publish completion before
        // persistence and account refresh finish. A retry resumes these steps.
        record.confirmed = update;
        try {
          record.saved ??= saveScannedAccount(this.options.paths, update.account).account;
          await this.options.accountManager.refreshAccount(record.saved.accountId);
        } catch (error) { throw new LoginCompletionPendingError(error); }
        record.account = publicAccount(record.saved);
      }
      record.status = update.status;
      return { status: record.status, ...(record.account ? { account: record.account } : {}) };
    })();
    record.polling = work;
    try { return await work; }
    finally { if (record.polling === work) record.polling = undefined; }
  }
}
