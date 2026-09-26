import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react()],
    server: {
      port: 4173,
      host: '127.0.0.1',
      proxy: {
        '/ai-api': {
          target: env.ALGFLOW_AI_GATEWAY_TARGET || 'http://127.0.0.1:8788',
          rewrite: (path: string) => path.replace(/^\/ai-api(?=\/|$)/, ''),
        },
      },
    },
  };
});
