import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.imagineluc.xunji",
  appName: "循记",
  webDir: "mobile-dist",
  server: {
    androidScheme: "https",
    // The current IP-only backend is for device testing only. Turn this off
    // once the API moves to an HTTPS domain.
    cleartext: true,
  },
};

export default config;
