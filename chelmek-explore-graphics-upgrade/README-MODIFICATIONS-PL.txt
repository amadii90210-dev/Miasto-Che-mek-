CHEŁMEK EXPLORE — pakiet zmian graficznych

Zakres tej kopii
----------------
Pakiet powstał na podstawie archiwum grok-workspace.zip w publicznym repozytorium:
https://github.com/amadii90210-dev/Che-mek-EXPLORE-2

Zmiany:
- proceduralne tekstury asfaltu i płyt chodnikowych, tworzone lokalnie w canvasie;
- gęstszy, bardziej szczegółowy materiał zieleni;
- przerywane oznakowanie głównych dróg;
- przełącznik jakości: Auto / Płynnie / Detale. Auto dobiera limit rozdzielczości do małego ekranu i obsługi dotykiem; Płynnie obniża koszt renderowania, Detale podnosi limit rozdzielczości;
- czytelniejszy przycisk grafiki i opis ustawień po polsku.

Weryfikacja
-----------
`npm run typecheck` — OK
`npm run build:dev` — OK
Build zgłasza ostrzeżenia o rozmiarze części bundla i dyrektywach `use client` z zależności. Nie przerwały kompilacji.
Testu interaktywnego w Chromium nie udało się wykonać w tym środowisku z powodu brakujących bibliotek systemowych przeglądarki.

Wdrożenie
---------
Zmiany nie zostały wypchnięte do GitHuba ani wdrożone na Vercel. Ten ZIP zawiera kopię źródeł; nie zawiera node_modules ani wygenerowanego builda. Do lokalnej instalacji: `npm ci`, a następnie `npm run dev`.

Uwaga o wersji
--------------
Repozytorium przechowuje właściwą aplikację w archiwum grok-workspace.zip. Kod tej aplikacji ma wybór postaci i eksplorację pieszą. Podczas wcześniejszej inspekcji publiczna strona Vercel pokazywała inny zestaw mechanik (m.in. pojazdy i wieżę). Przed zastąpieniem źródeł produkcyjnych upewnij się, że Vercel wdraża właśnie aplikację z tego archiwum.
