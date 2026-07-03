import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gestimmo.app',
  appName: 'GestImmo',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  }
};

export default config;
