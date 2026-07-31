# Code review auditních oprav — gpt-5.6-sol

**Datum:** 28. 7. 2026
**Rozsah:** `1ecb7655..84aa8686` (12 commitů, 48 souborů, +1287/−151)
**Recenzenti:** 7 (`rev-brain`, `rev-workflow`, `rev-cron-whatsapp`, `rev-store`, `rev-cli`, `rev-web-lib`, `rev-web-ui`)

Poznámka k podkladům: výsledek `rev-web-ui` byl v předaném dependency payloadu zkrácen. Viditelnou část jsem zahrnul a časný editorový nález jsem znovu ověřil přímo proti aktuálnímu kódu a implementaci TanStack `MutationObserver`.

## Verdikt

Celek zatím **není bezpečné nasadit**. Jeden společný blocker ve workflow enginu má dvě ověřené startovací race podoby: explicitně zastavený nebo reloadem zrušený workflow může ještě vytvořit child běh, který už teardown nezachytí. Webová část samostatný deployment blocker nemá; před nasazením celého balíku je ale nutné opravit workflow cancellation a doplnit deterministické regresní testy.

## BLOCKERS

### 1. Cancellation nefencuje uzly ve fázi startu

**Místa:** `plugins/subagent/lib/workflow.mjs:278-300`, `plugins/subagent/lib/workflow.mjs:693-710`; hostovní okno je v `src/brain/channels.ts:228-241` a `src/brain/channels.ts:290-368`
**Recenzent:** `rev-workflow`

`runNode()` po `await buildNodeAccess()` nekontroluje, zda byl workflow mezitím zrušen. U explicitního modelu může `buildNodeAccess()` čekat na `ctx.listModels()`, takže `WorkflowStop` nebo `plugin.reload.before` nastaví `wf.finished`, ale stará continuation pak stejně zavolá `getRun()` a vytvoří child.

Druhé okno začíná uvnitř hosta: delegated call je zaregistrován před prvním `await`, ale `session` event vznikne až po locku a případném spawnu. `WorkflowStop` sbírá pouze uzly s již známým `sessionId`, takže rozbíhající se child mine; pozdní `session` event už nic nezastaví. Při reloadu může child vzniknout až po snapshotu `resetChannels()` a zůstat bez dosažitelného workflow enginu. To porušuje explicitní stop, může dál používat nástroje a pálit tokeny po oznámeném zrušení.

**Oprava:** zavést per-run cancellation token nebo generační číslo. Kontrolovat je po každé asynchronní hranici a těsně před `getRun()`, propagovat `AbortSignal` do hostovní run path a pozdní `session` event z cancelled generace okamžitě zastavit. `WorkflowStop` a reload musí čekat na doběhnutí všech launch/stop operací. Přidat deterministické testy pro (a) zablokovaný `listModels()`, (b) vstup do `run` před `session` eventem a (c) skutečný plugin reload přes host lifecycle. Současné fake testy emitují `session` synchronně a oba závody maskují.

## SHOULD-FIX

### 1. Restartové smetení delegací je lazy, ne globální boot operace

**Místa:** `src/brain/brainService.ts:1097-1143`, `src/daemon/bootstrap.ts:904-920`, `src/brain/service/statusService.ts:127-149`
**Recenzent:** `rev-brain`

Sweep běží až při prvním `BrainService.start()` konkrétní session. Session ale může předtím ožít přes bound `send()` nebo cron `originSend`; první otevření webu pak v registračním okně označí živý běh za restartového sirotka. Channel/task session se přes owner `start()` nemusí dostat nikdy, takže jejich workflow zůstává v databázi `running`; zobrazovací transformace v `statusService` stav neopravuje trvale a po oživení originu se phantom stav může vrátit.

**Oprava:** synchronní jednorázové `reconcileDelegationsOnBoot()` nad všemi durable sub-agent/workflow řádky před `startPlatforms()`. Tím lze odstranit i neomezeně rostoucí `orphanSweptSessions` Set.

### 2. Workflow resume kombinuje starý channel s novým scope

**Místa:** `plugins/subagent/lib/workflow.mjs:598-615`, `src/brain/channels.ts:191-200`
**Recenzent:** `rev-brain`

Resume zachová původní `channelId`, ale znovu načte aktuální `parentAccess`. Persistovaný child vyžaduje přesnou shodu původního immutable scope, takže po zúžení projektů, permissions nebo tool policy pokračování skončí `delegated access unavailable`. Je to fail-safe, nikoli eskalace, ale porušuje slib resume a chyba je až uvnitř uzlu.

**Oprava:** použít hostovní continuation bridge, který porovná uložený scope s aktuálním. Je-li bezpečné pokračovat, použít původní child s dodatečnými deny; jinak ukončit resume explicitní srozumitelnou chybou nebo založit nový child pod aktuálním scope a jasně přiznat ztrátu původní session continuity. Doplnit integrační test přes skutečný `ChannelSessionService`.

### 3. Cancelled summary popírá, že uzel už mohl mít vedlejší efekty

**Místo:** `plugins/subagent/lib/workflow.mjs:338-346`
**Recenzent:** `rev-workflow`

Uzel se stavem `running` je po cancelu popsán jako „did not run“. Přitom mohl provést část práce; následné `WorkflowResume` ji může zopakovat.

**Oprava:** rozlišit `pending` („nespuštěno“) od `running` („spuštěno a přerušeno; mohou existovat částečné změny“).

### 4. Cron pending delivery nemá lease

**Místa:** `plugins/cronjob/index.mjs:567-595`
**Recenzent:** `rev-cron-whatsapp`

Starý adaptér může uložit pending výsledek a čekat v pomalém `deliver()`. Nová generace po reloadu načte stejný záznam a odešle ho znovu. Fronta nezná stav „právě doručováno“ ani owner/expiry.

**Oprava:** atomicky claimnout delivery záznam s ownerem a expirací ještě před odesláním; po úspěchu jej odstranit, po chybě lease uvolnit nebo nechat vypršet. Testovat reload s blokovaným `notify()`.

### 5. WhatsApp fork znovu driftuje od sdíleného live-message lifecycle

**Místa:** `plugins/whatsapp/lib/stream.mjs:30-87`, `plugins/whatsapp/lib/stream.mjs:215-217`, `plugins/whatsapp/lib/stream.mjs:235-265`; referenční implementace `plugins/_shared/liveMessage.mjs:37-165`, `plugins/_shared/liveMessage.mjs:325-335`
**Recenzent:** `rev-cron-whatsapp`

Tři projevy mají stejnou příčinu:

- `answerMode: 'live'` se spočítá, ale text delta se pouze akumuluje a nikdy se živě needituje, navzdory manifestu „tool calls + text“.
- `close()` nečeká na již běžící create/edit; po chybě turnu může pozdní progress zpráva přistát až pod chybovou odpovědí.
- Final settle má jediný pokus; transientní edit error může zmrazit zastaralý progress.

**Oprava:** parametrizovat shared `EditableMessage`/`StreamingAnswer` pro WhatsApp throttle a Baileys tombstone strategii, místo další paralelní lifecycle kopie. Zachovat lokálně jen transportní rozdíl. Doplnit test live textu, error během blokovaného create a retry prvního neúspěšného final editu.

### 6. Usage SQL validuje syntaxi JSON, ne typy

**Místo:** `src/store/brainUsageStore.ts:23-58`
**Recenzent:** `rev-store`

`json_valid` pustí numeric stringy i dvojitě serializovaný bucket. SQLite je při `SUM()` může převést na čísla, zatímco `rollupDroppedUsage()` po kompaktaci přijímá jen skutečné finite numbers. Statistiky se tak mohou kompaktací změnit.

**Oprava:** vyžadovat `je.type = 'object'`; pro číselná pole používat `json_type(...) IN ('integer', 'real')`; u assistant větve ověřit objektový tvar zprávy a `usage`. Testovat numeric string, běžný string a serializovaný objekt uvnitř stringu.

### 7. Platné JSON skaláry stále mohou shodit čtení historie nebo výsledků

**Místa:** `src/brain/messageView.ts:329-330,405-415`, `src/brain/persistence.ts:350-358`, `src/store/brainDelegationStore.ts:524-547`
**Recenzent:** `rev-store`

Oprava zachytí syntakticky rozbitý JSON, ale `JSON.parse('null')` ani `JSON.parse('1')` nevyhodí. `extractText(null)`, rehydratace přes `msg.role` a workflow větev přes `payload.result` pak mohou vyhodit `TypeError` a zablokovat celý transcript nebo pending-result drain.

**Oprava:** parsovat do `unknown` a na každé storage hranici přijmout jen neprázdný non-array objekt; u zpráv navíc vyžadovat řetězcový `role`. `extractText()` musí bezpečně přijmout libovolné `unknown`. Přidat regresní testy pro `null`, číslo a zdravé řádky kolem poškozeného záznamu.

### 8. Unattended installer má nejednoznačný parserový kontrakt

**Místa:** `src/cli/flags.ts:10-14`, `src/cli/install/index.ts:238-289`
**Recenzent:** `rev-cli`

Valueless flag se mění na default (`--user --agents all`, `--domain --no-tls`) a neúplný pár admin údajů se tiše zahodí. Nový parser zároveň odstranil možnost předat hodnotu začínající `--`, aniž podporuje jednoznačné `--name=value`. Dokumentovaný `--ip` alias navíc `deploymentFromArgs()` nečte.

**Oprava:** u přítomného flagu bez hodnoty skončit parse chybou, totéž pro neúplný admin pár; podporovat `--name=value`; číst `--host` s fallbackem na `--ip`. Doplnit tabulkové parser testy pro všechny deklarované flagy.

### 9. Setup neumí zotavit nezdravý daemon a retry nemá celkový deadline

**Místa:** `src/cli/setup/command.ts:100-113`, `src/cli/launcher.ts:61-75,207-241`
**Recenzent:** `rev-cli`

Když `/health` vrací 500, `systemctl start` běžící službu neopraví. Lokální launcher zase adoptuje živý tracked PID bez ohledu na health. Setup tedy skončí timeoutem místo deklarovaného zotavení. Navíc každý z 50/100 pokusů může čekat tři sekundy, takže původně krátké readiness okno může trvat minuty.

**Oprava:** u systemd použít po neúspěšném health checku `restart`; u lokálně vlastněného procesu bezpečné `down`/`up`. Sdílet jednu deadline-based readiness smyčku, kde jednotlivý fetch spotřebovává pouze zbývající čas. Testovat skutečný lifecycle, ne mock celého `runLifecycle()`.

### 10. Nový web client-surface guard má false positives a sám ponechal mrtvé `ready`

**Místa:** `web/lib/elowenClient.ts:58`, `web/tests/lib/elowenClientSurface.test.ts:29-37`
**Recenzent:** `rev-web-lib`

`elowenClient.ready` nemá produkčního konzumenta. Regex guard jej považuje za používaný jen proto, že slovo `ready` existuje v nesouvisejícím kódu; nezvládá spolehlivě aliasy ani computed access.

**Oprava:** odstranit wrapper a analyzovat skutečné property accessy/importy přes TypeScript AST.

### 11. Po odstranění mission detailu zůstaly mrtvé invalidace a guard je nevidí

**Místa:** `web/lib/mutations.ts:53,81,102`, `web/tests/lib/elowenClientSurface.test.ts:40-53`
**Recenzent:** `rev-web-lib`

Tři invalidace prefixu `['mission']` míří na query, která už neexistuje; dva komentáře popisují odstraněný detail view. Test pro invalidace čte jen `useElowenEvents.ts`, automaticky důvěřuje všem `QUERY_KEYS` a používá řádkové regexy, takže tento zbytek nezachytí.

**Oprava:** odstranit všechny tři invalidace a zastaralé komentáře. Guard postavit nad AST všech produkčních `invalidateQueries` a skutečných query registrací, nebo jej výslovně zúžit a nepovažovat za generickou architektonickou bránu.

### 12. Consecutive file saves ztrácejí starší per-call callback

**Místo:** `web/modules/projects/editor/ProjectEditor.tsx:140-157`; chování knihovny `web/node_modules/@tanstack/query-core/src/mutationObserver.ts:128-176`
**Recenzent:** `rev-web-ui` (předaný výsledek byl zkrácen; nález byl znovu ověřen při syntéze)

Každé `write.mutate(..., { onSuccess })` odpojí observer od předchozí mutation a nahradí `#mutateOptions`. Když uživatel uloží A, přepne tab a uloží B před dokončením A, callback A se nespustí; jeho draft/dirty stav a toast zůstanou nekonzistentní.

**Oprava:** přesunout per-save cleanup do lifecycle, který je svázaný s variables každé mutation (například `mutateAsync` s vlastním awaited continuation nebo hook-level callback s per-path revision), ne do observer callbacku posledního `mutate()`.

### 13. `draftsRef` se aktualizuje až pasivním efektem

**Místa:** `web/modules/projects/editor/ProjectEditor.tsx:60-63,118-122,145-153`
**Recenzent:** `rev-web-ui`

Síťová odpověď může doběhnout mezi render commitem nového textu a `useEffect`, přečíst starý draft a smazat právě napsané znaky. Současný test před uvolněním Promise efekty vyflushuje a okno neověřuje.

**Oprava:** ref aktualizovat atomicky v updateru změny nebo použít explicitní per-path revision; test dokončení requestu ve stejném event turnu jako editaci.

### 14. File-write scope zbytečně serializuje všechny projekty a soubory

**Místo:** `web/lib/mutations.ts:423-431`
**Recenzent:** `rev-web-ui`

Konstantní scope `project-file-write` je globální pro celý `QueryClient`. Pomalé uložení jednoho souboru blokuje nezávislé ukládání jiného tabu, projektu i cesty.

**Oprava:** scope odvodit alespoň z `projectId + path`, případně použít per-resource frontu. Testovat serializaci stejného souboru a souběh různých souborů.

### 15. Queue rollback není svázán se session ani autoritativním snapshotem

**Místo:** `web/modules/advisor/BrainChatProvider.tsx:737-748`
**Recenzent:** `rev-web-ui`

Pozdní chyba DELETE ze session A může po přepnutí vložit položku do fronty B. Pozdní `catch` může také přepsat novější serverový queue snapshot. Protože ID fronty jsou poziční, ghost položka může později cílit na jinou zprávu.

**Oprava:** zachytit session, generation a queue epoch; rollback povolit jen pokud jsou stále aktuální a nepřišel novější snapshot. Testovat chybu po switchi session a po serverovém snapshotu.

### 16. Seed-once profil může vracet externí změny zpět

**Místo:** `web/modules/account/AccountView.tsx:167-188`
**Recenzent:** `rev-web-ui`

`formSeeded` chrání lokální rozepsaný text, ale ignoruje všechny další autoritativní změny stejného uživatele. Změní-li jiné okno jméno a zde se upraví jen e-mail, autosave odešle i staré jméno a externí změnu přepíše.

**Oprava:** per-field baseline/dirty stav a PATCH pouze změněných polí; nedotčená pole průběžně synchronizovat z `/auth/me`.

### 17. Provider probe může přepsat novější katalog starou odpovědí

**Místo:** `web/modules/settings/BrainSection.tsx:163-173`
**Recenzent:** `rev-web-ui`

Cleanup ruší jen debounce timer, ne již běžící request. Pomalá odpověď starého URL může přepsat modely pro nové URL.

**Oprava:** generation/cancelled guard nebo `AbortController`; regresní test s odpověďmi v opačném pořadí.

### 18. Nové web testy porušují deklarovaný TypeScript zákaz non-null assertions

**Místa:** `web/tests/lib/elowenClientSurface.test.ts:44,51`, `web/tests/modules/settings/BrainSection.test.tsx:120`
**Recenzenti:** `rev-web-lib`, `rev-web-ui`

Nově přidané `m[1]!` a `resolve!()` odporují konvenci repozitáře pro `web/`.

**Oprava:** capture/callback před použitím explicitně zúžit a při chybě vyhodit popisnou výjimku.

## NITS

- `plugins/subagent/lib/workflow.mjs:357-365,422-427` — cancel publikuje terminální snapshot a `runToCompletion().then()` jej publikuje znovu. Promise se nedokončí dvakrát, ale vzniká duplicitní SQLite write a broadcast. (`rev-workflow`)
- `src/brain/brainService.ts:76,1105-1109` — `orphanSweptSessions` se nikdy nečistí při delete/rekey/rollover. Globální boot sweep Set odstraní. (`rev-brain`)
- `web/modules/settings/BrainSection.tsx:54-70` — `setInterval` dovoluje překryv OAuth pollů a starší neterminální odpověď může krátce vrátit UI zpět. Plánovat další poll až po dokončení předchozího. (`rev-web-ui`)
- `web/tests/lib/writeProjectFile.test.tsx:11-38` — ordering test používá reálné 60/5ms prodlevy a může na zatíženém CI projít bez skutečné serializace. Použít deferred Promise. (`rev-web-ui`)
- `web/tests/modules/editor/ProjectEditorSave.test.tsx:88-90` — test po úspěšném save očekává návrat ke starému `SERVER_CONTENT`, tedy chování, které by v reálném UI bylo regrese. Testovat reálný cache update a zachování uloženého textu. (`rev-web-ui`)
- `web/modules/settings/BrainSection.tsx:73-76` — OAuth dialog nemá přístupné jméno; použít shared `Modal` nebo `aria-labelledby`. (`rev-web-ui`)
- `web/modules/settings/BrainSection.tsx:48,93,559-565` — cancel a chyba mají stejný boolean výsledek, takže Cancel zobrazí červený failure toast. Rozlišit `success | error | cancelled`. (`rev-web-ui`)

## Zamítnuté nálezy

### Cron claim musí být atomický mezi procesy

**Nahlásil:** `rev-cron-whatsapp`, `plugins/cronjob/index.mjs:556-564`

V podporované topologii existuje jeden daemon proces. Při plugin reloadu soutěží dvě generace adaptéru ve stejném event loopu a synchronní read-check-write se mezi nimi neproloží; přesně tento případ současná oprava řeší. Dva daemon procesy nad jedním `jobs.json` nejsou podporovaný režim a rozbily by více subsystémů než jen claim. SQLite/lock by byl rozumný hardening pro budoucí multi-process scheduler, ne deployment defect těchto commitů.

### `GET /brain/queue` je mrtvý endpoint a má se odstranit

**Nahlásil:** `rev-web-lib`, `src/api/routes/brain.ts:618-623`

Web wrapper byl skutečně mrtvý a správně zmizel, ale serverová route je dokumentované veřejné REST API s autorizačními a kontraktními testy. Absence webového volajícího není důkaz, že endpoint nemá externího klienta. Bez explicitního rozhodnutí o breaking API změně jej nelze označit za mrtvý kód.

### `PreflightResult.buildTools` a `ElowenClient.createTask()` se mají odstranit v tomto balíku

**Nahlásil:** `rev-cli`, `src/cli/install/preflight.ts:15,34`, `src/cli/client.ts:14`

Oba body mohou být samostatný cleanup, ale kontrolované commity tyto řádky neměnily a jejich odstranění není nutné k dokončení žádné z auditních oprav. `createTask()` navíc mapuje podporovaný `/tasks` kontrakt. Nejde o regresi ani zapomenutý zbytek vytvořený tímto rozsahem.

### Nedostatečné workflow testy jako samostatný produktový nález

**Nahlásil:** `rev-workflow`

Testová mezera je reálná, ale není oddělenou vadou vedle cancellation race. Je zahrnuta přímo do opravy BLOCKERU; samostatné počítání by tutéž příčinu duplikovalo.

## Co je naopak dobře

- Workflow ownership a origin-only autorizace pro resume/stop jsou konzistentní; nebyl nalezen cross-session ani cross-user únik.
- `terminalizeWorkflow()` je sdílený a běžná terminalizace není implementována několika konkurenčními cestami.
- Cron reload claim je pro skutečný single-process reload správně synchronní a atomic rename chrání soubor před částečným zápisem.
- WhatsApp opravy správně serializují create/edit, mají trailing flush a zachovávají nejnovější konec dlouhého progressu.
- Store SQL správně izoluje syntakticky malformed JSON a zachovává session bez zpráv; problém zůstává pouze v type/shape validaci.
- Web změny zachovaly i18n klíče v češtině, slovenštině i angličtině a odstranění mission-detail DTO/exportů nerozbilo používané kontrakty.
- Dodané brány byly čisté: root check, 5004 root testů, web TypeScript a 1136 web testů. Review ale správně odhalilo lifecycle závody, které současné fake/unit testy neprovádějí.
