export interface Driver {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  read(selector: string): Promise<string>;
  screenshot(path: string): Promise<string>;
  close(): Promise<void>;
}

export interface DriverOptions {
  headless?: boolean;
  profilePath?: string;
  timeoutMs?: number;
  paceMs?: number;
  allowedOrigins: string[];
}
