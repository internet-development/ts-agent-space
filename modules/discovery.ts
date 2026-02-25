//NOTE(jimmylee): mDNS Discovery Module
//NOTE(jimmylee): Advertises the space server on the local network via mDNS.
//NOTE(jimmylee): Agents on the same WiFi find the server automatically.

import Bonjour, { type Service } from 'bonjour-service';
import { MDNS_SERVICE_TYPE } from '@common/config.js';

export class SpaceDiscovery {
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  private service: Service | null = null;

  //NOTE(jimmylee): Start advertising the space on mDNS
  start(port: number, spaceName: string): void {
    this.bonjour = new Bonjour();

    this.service = this.bonjour.publish({
      name: spaceName,
      type: MDNS_SERVICE_TYPE,
      port: port,
    });
  }

  //NOTE(jimmylee): Stop advertising
  stop(): void {
    if (this.service) {
      this.service.stop?.();
      this.service = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }
}
