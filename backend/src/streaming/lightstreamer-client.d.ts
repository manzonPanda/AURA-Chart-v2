/**
 * Ambient declarations for the CommonJS `lightstreamer-client` npm package
 * (v7.3.2, deprecated but the canonical Lightstreamer JS client referenced by
 * IG's streaming guide). It ships no types, so we declare only the surface we
 * use. The default export is the CJS `module.exports` object.
 */
declare module "lightstreamer-client" {
  export interface SubscriptionListener {
    onSubscription?(): void;
    onUnsubscription?(): void;
    onSubscriptionError?(code: number, message: string): void;
    onClear?(itemName: string, itemPos: number): void;
    onItemUpdate?(info: SubscriptionUpdateInfo): void;
  }

  export interface SubscriptionUpdateInfo {
    getItemName(): string;
    getItemPos(): number;
    getValue(field: string): string | null;
    isSnapshot(): boolean;
    forEachField(cb: (fieldName: string, fieldPos: number, value: string) => void): void;
  }

  export interface ClientListener {
    onListenStart?(): void;
    onListenEnd?(): void;
    onStatusChange?(status: string): void;
    onServerError?(code: number, message: string): void;
    onPropertyChange?(prop: string, oldVal: string | null, newVal: string | null): void;
  }

  export class Subscription {
    constructor(mode: "MERGE" | "DISTINCT" | "RAW", itemList: string[] | string, fieldList?: string[] | string);
    setRequestedSnapshot(value: "yes" | "no" | number | null): void;
    setRequestedMaxFrequency(frequency: string | number | null): void;
    setDataAdapter(name: string): void;
    addListener(listener: SubscriptionListener): void;
    removeListener(listener: SubscriptionListener): void;
  }

  export class LightstreamerClient {
    constructor(serverAddress: string, adapterSet?: string | null);
    connectionDetails: {
      setUser(user: string): void;
      setPassword(pw: string): void;
      setServerInstance(instance: string): void;
      setAdapterSet(adapter: string | null): void;
    };
    connectionOptions: {
      setSlowingEnabled(value: boolean): void;
      setReconnectTimeout(ms: number): void;
      setMaxReconnectAttempts(attempts: number): void;
    };
    addListener(listener: ClientListener): void;
    connect(): void;
    disconnect(): void;
    subscribe(sub: Subscription, listener?: SubscriptionListener): void;
    unsubscribe(sub: Subscription, listener?: SubscriptionListener): void;
  }

  /**
   * The package is CommonJS with dynamically-discovered exports. In Node ESM
   * only the `default` (module.exports) is reliably available, so the ambient
   * type exposes the same shape as the default import.
   */
  const _default: {
    LightstreamerClient: typeof LightstreamerClient;
    Subscription: typeof Subscription;
  };
  export default _default;
}