export interface HarnessSettings {
  /** OpenAI-compatible endpoint of the local proxy, not an upstream provider. */
  baseUrl: string;
  /** Local proxy client token, never a provider credential. */
  apiKey: string;
  model: string;
  /** Bare local proxy origin for Anthropic-compatible clients. */
  anthropicBaseUrl?: string;
}

export interface Usage {
  remainingPercent: number;
  resetsAt?: string;
}

export interface Harness {
  get_usage(): Promise<Usage | null>;
  detect_limit(status: number): boolean;
  set_api_key(settings: HarnessSettings): Promise<void>;
  reload(): Promise<void>;
}
