export interface SaveSlotInfo {
  slot: string;
  exists: boolean;
  savedAt?: string;
  formatVersion?: number;
  gameVersion?: string;
  size?: number;
  error?: string;
}

export interface SaveSlotInfo {
  slot: string;
  exists: boolean;
  savedAt?: string;
  formatVersion?: number;
  gameVersion?: string;
  size?: number;
  error?: string;
}

export interface DesktopSimApi {
  platform: string;
  saves: {
    list(): Promise<{ ok: boolean; slots: SaveSlotInfo[]; error?: string }>;
    read(slot: string): Promise<{ ok: boolean; slot: string; text?: string; savedAt?: string; error?: string }>;
    write(slot: string, text: string): Promise<{ ok: boolean; slot: string; savedAt?: string; error?: string }>;
    remove(slot: string): Promise<{ ok: boolean; error?: string }>;
  };
  app: {
    info(): Promise<{
      platform: string;
      appVersion: string;
      electronVersion: string;
      saveDirectory: string;
    }>;
    quit(): void;
  };
  onMenuAction(callback: (action: string) => void): () => void;
}

declare global {
  interface Window {
    desktopSim?: DesktopSimApi;
  }
}
