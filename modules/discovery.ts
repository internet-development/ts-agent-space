//NOTE(jimmylee): mDNS Discovery Module
//NOTE(jimmylee): Advertises the space server on the local network via mDNS.
//NOTE(jimmylee): Agents on the same WiFi find the server automatically.

import BonjourModule, { type Service } from 'bonjour-service';

const Bonjour = (BonjourModule as any).default ?? BonjourModule;
import { MDNS_SERVICE_TYPE } from '@common/config.js';

export class SpaceDiscovery {
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  private service: Service | null = null;

  //NOTE(jimmylee): Start advertising the space on mDNS
  //NOTE(jimmylee): Wraps Bonjour init and publish in try-catch with descriptive logging
  //NOTE(jimmylee): Callers should also catch — this is defense-in-depth
  start(port: number, spaceName: string): void {
    try {
      this.bonjour = new Bonjour();
      //NOTE(jimmylee): Attach error handler — prevents unhandled error events from crashing the server
      //NOTE(jimmylee): mDNS errors (multicast failure, subnet changes) should be logged, not fatal
      if (typeof this.bonjour.on === 'function') {
        this.bonjour.on('error', (err: unknown) => {
          console.error(`[mDNS] Bonjour error (non-fatal): ${String(err)}`);
        });
      }
    } catch (err) {
      console.error(`[mDNS] Failed to initialize Bonjour: ${String(err)}`);
      throw err;
    }

    try {
      this.service = this.bonjour.publish({
        name: spaceName,
        type: MDNS_SERVICE_TYPE,
        port: port,
      });
    } catch (err) {
      console.error(`[mDNS] Failed to publish service ${spaceName} on port ${port}: ${String(err)}`);
      //NOTE(jimmylee): Clean up partial init — Bonjour was created but publish failed
      try { this.bonjour.destroy(); } catch {}
      this.bonjour = null;
      throw err;
    }
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
