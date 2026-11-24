import { useCallback, useState } from "react";

import { Palette, usePaletteShortcut } from "@/app/components/palette";
import { Rail } from "@/app/components/nav";
import { Home } from "@/app/screens/home";
import { People } from "@/app/screens/people";
import { Personalities } from "@/app/screens/personalities";
import { Events } from "@/app/screens/events";
import { Person } from "@/app/screens/person";
import { Review } from "@/app/screens/review";
import { Settings } from "@/app/screens/settings";
import { useRoute } from "@/lib/router";

export function App() {
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteShortcut(openPalette);

  return (
    <div className="bg-background text-foreground flex h-full overflow-hidden">
      <Rail current={route} onSearch={openPalette} />

      {/*
        relative: an absolutely positioned descendant (the hidden input a
        Radix checkbox renders) takes main as its containing block, so it
        scrolls inside main instead of growing the document under the rail.
      */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl p-6 lg:p-8">
          {route.name === "dashboard" ? <Home /> : null}
          {route.name === "people" ? <People /> : null}
          {route.name === "personalities" ? <Personalities /> : null}
          {route.name === "person" ? <Person personId={route.personId} /> : null}
          {route.name === "events" ? <Events /> : null}
          {route.name === "review" ? <Review /> : null}
          {route.name === "settings" ? <Settings /> : null}
          {route.name === "unknown" ? (
            <div className="py-20 text-center">
              <h1 className="font-heading text-xl font-semibold">Nothing at {route.path}</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                The rail on the left has everywhere there is to go.
              </p>
            </div>
          ) : null}
        </div>
      </main>

      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
