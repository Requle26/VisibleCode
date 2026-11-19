import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.TRACE_BACKEND_URL || 'http://127.0.0.1:8787';
  return {
    build: { chunkSizeWarningLimit: 800 },
    server: { strictPort: true, proxy: { '/api': {
      target, changeOrigin: true,
      headers: target.startsWith('https://') && env.TRACE_API_TOKEN ? { authorization: `Bearer ${env.TRACE_API_TOKEN}` } : undefined,
    } } },
  };
});
