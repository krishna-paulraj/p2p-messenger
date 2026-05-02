import { useEffect } from "react";
import { Composer } from "./components/Composer";
import { ContactList } from "./components/ContactList";
import { Conversation } from "./components/Conversation";
import { ConversationHeader } from "./components/ConversationHeader";
import { Header } from "./components/Header";
import { LoginPanel } from "./components/LoginPanel";
import { loadIdentity } from "./db/store";
import { useApp } from "./store/app";

export function App() {
  const ready = useApp((s) => s.ready);
  const identity = useApp((s) => s.identity);
  const init = useApp((s) => s.init);

  // If we already have a persisted identity, init silently on first mount.
  useEffect(() => {
    void (async () => {
      const stored = await loadIdentity();
      if (stored) {
        await init({ alias: stored.alias }).catch((err) => {
          console.error("init failed:", err);
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready || !identity) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <LoginPanel />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <ContactList />
        <main className="flex flex-1 flex-col bg-slate-950">
          <ConversationHeader />
          <Conversation />
          <Composer />
        </main>
      </div>
    </div>
  );
}
