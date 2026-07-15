import type { Channel, Connector } from "@indeedee/shared";

export type ConnectorFactory = (config: Record<string, unknown>) => Connector;

const registry = new Map<Channel, ConnectorFactory>();

export function registerConnector(channel: Channel, factory: ConnectorFactory): void {
  registry.set(channel, factory);
}

export function createConnector(
  channel: Channel,
  config: Record<string, unknown>,
): Connector {
  const factory = registry.get(channel);
  if (!factory) {
    throw new Error(`No connector registered for channel: ${channel}`);
  }
  return factory(config);
}

export function supportedChannels(): Channel[] {
  return [...registry.keys()];
}
