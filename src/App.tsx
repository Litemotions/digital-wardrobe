import { useCallback, useEffect, useState } from "react";
import type { ClothingItem, Look, ModelPhoto } from "./types";
import { getItems, getLooks, getModels } from "./db";
import { Wardrobe } from "./components/Wardrobe";
import { MePhoto } from "./components/MePhoto";
import { StyleStudio } from "./components/StyleStudio";
import { Lookbook } from "./components/Lookbook";

type Tab = "wardrobe" | "me" | "studio" | "looks";

const ACTIVE_KEY = "dw.activeModel";

export function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [items, setItems] = useState<ClothingItem[]>([]);
  const [models, setModels] = useState<ModelPhoto[]>([]);
  const [looks, setLooks] = useState<Look[]>([]);
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY)
  );
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(
    null
  );

  const reloadItems = useCallback(() => {
    getItems().then(setItems);
  }, []);
  const reloadModels = useCallback(() => {
    getModels().then(setModels);
  }, []);
  const reloadLooks = useCallback(() => {
    getLooks().then(setLooks);
  }, []);

  useEffect(() => {
    reloadItems();
    reloadModels();
    reloadLooks();
  }, [reloadItems, reloadModels, reloadLooks]);

  // Keep the active model valid and persisted.
  useEffect(() => {
    if (models.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !models.some((m) => m.id === activeId)) {
      setActiveId(models[0].id);
    }
  }, [models, activeId]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
    else localStorage.removeItem(ACTIVE_KEY);
  }, [activeId]);

  const showToast = useCallback((msg: string, error?: boolean) => {
    setToast({ msg, error });
    window.clearTimeout((showToast as any)._t);
    (showToast as any)._t = window.setTimeout(
      () => setToast(null),
      error ? 6000 : 2600
    );
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">👗</span>
        <div>
          <h1>Digital Wardrobe</h1>
          <div className="sub">Mix, match & try it on — you</div>
        </div>
      </header>

      {tab === "wardrobe" && <Wardrobe items={items} reload={reloadItems} />}
      {tab === "me" && (
        <MePhoto
          models={models}
          activeId={activeId}
          setActiveId={setActiveId}
          reload={reloadModels}
        />
      )}
      {tab === "studio" && (
        <StyleStudio
          models={models}
          activeId={activeId}
          items={items}
          reloadLooks={reloadLooks}
          goToMe={() => setTab("me")}
          goToWardrobe={() => setTab("wardrobe")}
          toast={showToast}
        />
      )}
      {tab === "looks" && <Lookbook looks={looks} reload={reloadLooks} />}

      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`}>{toast.msg}</div>
      )}

      <nav className="tabbar">
        <TabButton tab="studio" cur={tab} set={setTab} icon="✨" label="Studio" />
        <TabButton
          tab="wardrobe"
          cur={tab}
          set={setTab}
          icon="🧺"
          label="Wardrobe"
        />
        <TabButton tab="me" cur={tab} set={setTab} icon="🧍" label="Me" />
        <TabButton tab="looks" cur={tab} set={setTab} icon="📸" label="Looks" />
      </nav>
    </div>
  );
}

function TabButton({
  tab,
  cur,
  set,
  icon,
  label,
}: {
  tab: Tab;
  cur: Tab;
  set: (t: Tab) => void;
  icon: string;
  label: string;
}) {
  return (
    <button
      className={cur === tab ? "active" : ""}
      onClick={() => set(tab)}
    >
      <span className="ic">{icon}</span>
      {label}
    </button>
  );
}
