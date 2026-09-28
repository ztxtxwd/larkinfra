import type { AppConfig, AppEnv } from "@larkinfra/shared";

export type RegisterAppInput = {
  appId: string;
  appSecret: string;
  env?: AppEnv;
  upstreamConnections?: number;
};

export type RegisterAppResult =
  | { ok: true; app: AppConfig; created: boolean }
  | { ok: false; error: string };

/**
 * Runtime registry of Feishu apps.
 * Filled only when agents call `/callback/ws/endpoint` with AppID/AppSecret.
 */
export class AppRegistry {
  private apps = new Map<string, AppConfig>();

  constructor(
    private defaults: { env: AppEnv; upstreamConnections: number } = {
      env: "dev",
      upstreamConnections: 1,
    },
  ) {}

  get(appId: string): AppConfig | undefined {
    return this.apps.get(appId);
  }

  has(appId: string): boolean {
    return this.apps.has(appId);
  }

  list(): AppConfig[] {
    return [...this.apps.values()];
  }

  listIds(): string[] {
    return [...this.apps.keys()];
  }

  /**
   * First-seen credentials register the app; subsequent calls must match secret.
   */
  registerOrAuth(input: RegisterAppInput): RegisterAppResult {
    const existing = this.apps.get(input.appId);
    if (existing) {
      if (existing.appSecret !== input.appSecret) {
        return { ok: false, error: "auth failed" };
      }
      return { ok: true, app: existing, created: false };
    }

    const app: AppConfig = {
      appId: input.appId,
      appSecret: input.appSecret,
      env: input.env ?? this.defaults.env,
      upstreamConnections:
        input.upstreamConnections ?? this.defaults.upstreamConnections,
    };
    this.apps.set(app.appId, app);
    console.info(
      `[apps] registered app=${app.appId} env=${app.env} upstream=${app.upstreamConnections}`,
    );
    return { ok: true, app, created: true };
  }
}
