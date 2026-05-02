import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "localhost",
  },
  optimizeDeps: {
    // Keep nostr-tools' deep imports happy in the dev bundler.
    include: ["nostr-tools/pure", "nostr-tools/pool", "nostr-tools/nip44", "nostr-tools/nip59"],
  },
});
