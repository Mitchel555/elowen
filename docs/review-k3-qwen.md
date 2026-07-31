# Code review 84aa8686..HEAD — sloučený verdikt (k3 + qwen)

Recenze rozsahu 84aa8686..0a170b0f (17 commitů, 51 souborů, +2180/-691). Čtyři oblasti (brain+store, plugins, cli, web) recenzovaly nezávisle dva modely: **k3** (kimi-coding) a **qwen** (alibaba/qwen3.8-max-preview). Tento dokument je sloučení; každý nález byl ověřen přímo v kódu. Označení **[oba]** = našly oba modely nezávisle (vysoká důvěra), **[k3]** / **[qwen]** = našel jeden, ověřeno ručně.

## BLOCKER

Žádný. Oba kandidáty na blocker (boot reconcile vs. druhá instance, viz nížsí should-fix #1) se po ověření ukázaly jako should-fix — dopad je dočasný a částečně samoléčivý.

## SHOULD-FIX

### 1. Boot reconcile běží před single-instance garancí — druhá instance nad stejnou DB zabije živé delegace [k3, qwen odmítl; ověřeno: k3 má pravdu]

`src/daemon/bootstrap.ts:915` volá `reconcileDelegationsOnBoot()` synchronně v `startLoops()`, tedy **před** `serve()` (`src/daemon/index.ts:81` vs `:86`) a před EADDRINUSE handlingem (`:94-97`). Žádný pid/db lock neexistuje — multi-instance je dokonce podporovaná feature (`src/cli/launcher.ts:230-231`: "Ports are overridable... so a second instance can run alongside").

Reconcile každý `running` řádek terminalizuje na `error` a pro autoDeliver enqueue syntetický výsledek "sub-agent interrupted by daemon restart" (`src/brain/brainService.ts:304-333`). Druhá instance (jiný `ELOWEN_PORT`, stejná DB) tak zabije živé delegace běžícího daemona. Self-healing existuje (last-write-wins upsert řádek vrátí, syntetický výsledek se upgraduje na reálný — `brainDelegationStore.ts:289-294, 400-405, 488-499`), ale rodič se probudí falešnou chybou **dřív**, než dorazí reálný výsledek — turn s "interrupted by daemon restart" už proběhl.

**Oprava:** volat `reconcileDelegationsOnBoot()` (a `reconcileGoalsOnBoot()`) až po úspěšném bindu portu v `serve()` callbacku, nebo je podmínit port/pid lockem.

### 2. Headless setup validuje flagy až PO `bringUp` — parse chyba nezabrání restartu daemonu [k3, qwen odmítl; ověřeno: k3 má pravdu]

`src/cli/setup/command.ts:21-25`: non-interactive větev volá nejdřív `bringUp(base, env, version)` (které při nezdravém daemonu dělá `systemctl restart`, viz #3), teprve pak `runHeadlessSetup`, kde `parseFlags` hodí (`headless.ts:32` → `:218`). `elowen setup --non-interactive --provider` (překlep) tak na boxu s neodpovídajícím daemonem restartne daemon a teprve potom zemře na parse chybě. Qwenovo "die() před prvním requestem" platí jen pro setup API requesty, ne pro stav stroje.

**Oprava:** v non-interactive větvi zavolat `parseFlags` (je pure a exportovaný) před `bringUp`.

### 3. `bringUp` restartuje po jediném selhaném probe a bez mission gate [oba]

`command.ts:112-119`: jediný `urlHealthy` (3s timeout, `launcher.ts:66`) → rovnou `systemctl restart` všech služeb → SIGTERM běžícím agentům. Dřív tam byl `start` (no-op na běžícím unitu). `update.ts:118` před restartem kontroluje `hasLiveMission(env)`, `bringUp` ne. Hrana navíc: když `ELOWEN_URL` míří na nedostupný vzdálený daemon, lokální cesta vezme `down` (`command.ts:126`) a shodí zdravý lokální daemon.

**Oprava:** před restartem 2–3 probe s prodlevou a/nebo `hasLiveMission` gate jako v `update.ts`.

### 4. `down` na non-Linuxu může SIGTERMnout cizí proces [k3]

`src/cli/launcher.ts:50-58`: `isTrackedService` mimo Linux vrací `true` jen na základě liveness pidu (`if (process.platform !== 'linux') return true`). `stop()` (`:153-154`) pak SIGTERMne pid z `run.json` — na macOS po rebootu může jít o recyklovaný pid cizího procesu. Dřív dokumentovaná slabina, ale `down` teď spouští `elowen setup` automaticky (násobí se s #2 a #3).

**Oprava:** na non-Linuxu ověřit identitu přes `ps -p <pid> -o command=` proti entry mark, nebo `down` z `bringUp` použít jen při ověřeném pidu.

### 5. `READY_BUDGET_MS = 5000` po restartu je těsný [k3]

`command.ts:101` čeká po `systemctl restart` jen 5s; instalátor na totéž čeká 20s (`src/cli/install/index.ts:66`) a launcher `start` taky 20s (`launcher.ts:228-229`). Daemon s DB migrací se za 5s zvednout nemusí → falešné "did not become healthy", přitom naběhne o pár sekund později.

**Oprava:** sjednotit na ~20s.

### 6. `--admin-user=x --admin-pass=` tiše přeskočí vytvoření admina [qwen]

`src/cli/install/index.ts:258,265`: kontrola páru vidí oba flagy jako non-`undefined` → projde; ale `adminUser && adminPass ? {...} : null` je pro `''` falsy → `admin = null`, instalace doběhne bez účtu a bez varování.

**Oprava:** po kontrole `undefined` odmítnout i prázdný řetězec.

### 7. Popis WorkflowStart inzeruje adresář, kam scoped uživatel nemůže zapsat [oba]

`plugins/subagent/lib/workflow.mjs:578,586` radí "Write it under `${workflowDir}`" (`:143` — `join(ctx.dataDir(), 'workflows')`, mimo repozitáře). `assertPathAllowed` (`src/plugins/pathGuard.ts:138-148`) pro ne-admin session povoluje jen repo roots + vlastní plan file + spill dir → Write na inzerovanou cestu hodí `path not allowed`. Pro project-scoped uživatele je primární instruovaná cesta mrtvá (repo fallback ve stejném popisu funguje, ale stojí zbytečné kolo error-retry). Admin projde, proto to nikdo nenahlásil.

**Oprava:** přidat `workflowDir` do per-session allowance (vzor spill dir), nebo popis ukazovat dataDir jen admin all-access sessionům.

### 8. Resume workflow uzlu se změněným scopem ztratí varování o částečných změnách [oba]

`plugins/subagent/lib/workflow.mjs:726-731`: při `scopeChanged` zůstane `resumed=false` → uzel dostane holý `node.task` bez `RESUME_NOTE` (`:380`, text `:152-154`), přestože jeho předchozí pokus mohl nechat částečné změny na disku a on je slepě zopakuje. Rodič varování dostane (`:748-752`), uzel ne. Zahození channelId je správně (host vyžaduje exact boundary match, `:716-720`), ale poznámka nevyžaduje resume session.

**Oprava:** když `prev.sessionId` existovalo, ale kanál se přenést nemohl, připnout uzlu variantu RESUME_NOTE ("earlier attempt may have left partial changes on disk").

### 9. Pojistka proti osiřelým workflow dětem nesepne při self-expansion [k3; ověřeno s korekcí místa]

Zranitelné místo je `plugins/subagent/lib/workflow.mjs:356` (`onEvent`: `if (wf.finished) void ctx.stopSubagent?.(e.sessionId)`), ne `:819` jak k3 uvedl — tam je try/catch i origin-only guard (`:820,833-841`). Když uzel sám zavolá WorkflowAddNodes, `tick` spustí nový uzel v ALS kontextu node turnu; host `stopSubagent` validuje parent vůči `currentSessionId()` z ALS (`src/plugins/registry.ts:363-368`, `src/brain/brainService.ts:1249-1251`), ale persistovaný parent je `wf.originSessionId` (`workflow.mjs:328`) → parent mismatch → throw pod `void` → dítě běží dál osiřelé a rejection je unhandled. Vyžaduje vzácný race (self-expansion + stop workflow mezi spawnem a session eventem).

**Oprava:** minimálně `.catch()` s warn logem; pořádně — host seam zastavující workflow dítě podle id nezávisle na turn scope volajícího (engine zná `wf.originSessionId`).

### 10. Queue rollback při dvou souběžných selhaných remove rozhodí pořadí fronty [oba]

`web/modules/advisor/BrainChatProvider.tsx:746-763`: `onQueueRemove` chytá `index` vůči poli před odebráním, rollback spliceuje na stejný index. Fronta `[A,B,C]`, odeber B (idx 1), pak C (idx 1), oba DELETE selžou → rollback dá `[A,C,B]`, server drží `[A,B,C]`. Pořadí závisí na pořadí dokončení catchů; generation/session/epoch fence to nepokryje (`queueEpochRef` bumpuje jen server snapshot, `:570`). Fronta je řídicí (pořadí krmení agentovi), špatné pořadí přetrvá do dalšího snapshotu.

**Oprava:** při selhání nesplicovat ručně — refetchnout autoritativní frontu ze serveru (DELETE selhal, server ji drží), nebo rollbackovat před následníka zachyceného při kliku.

### 11. Per-field baseline profilu nerozezná vlastní echo od cizí změny — silent cross-window last-write-wins [k3]

`web/modules/account/AccountView.tsx:175-200`: okno 1 uloží name=B; než jeho refetch `/auth/me` dorazí, okno 2 změní name na C. Refetch vrátí C; lokální B ≠ baseline A → efekt (`:181`) to vyhodnotí jako probíhající editaci a B ponechá, baseline skočí na C (`:189`). Při příštím save (libovolná editace profilu) patch nese `name: B` ≠ base C → B tiše přebije C. (Korekce k3: přepsání není okamžité, nastane při dalším save — `useAutoSaveStatus.ts:83` deps se po refetchi nezmění.) Test `AccountView.test.tsx:164` pokrývá jen externí změnu needitovaného pole, ne tento scénář.

**Oprava:** per-field `lastSent`; server hodnotu adoptovat když `cur === baseline || cur === lastSent` (vlastní echo), jinak jde o uživatelský edit.

## NIT

- **`tokenTotals` bez type guardu** [qwen] — `src/store/brainStore.ts:222` čte `$.usage.totalTokens` jen s `json_valid`, zatímco `USAGE_ROWS` má `json_type(...) IN ('integer','real')` (`brainUsageStore.ts:12-13`). SQLite SUM zcoercuje string `"500"` → tokenTotals ukáže číslo, usageByModel 0. Test (`brainStore.test.ts:1021-1038`) tokenTotals proti stringům nepíche. Přidat stejný `json_type` check + test.
- **Rollup timestamp divergence** [oba, qwen blíž pravdě] — `brainUsageStore.ts:155,160`: řádek bez číselného `$.timestamp` dostane `at=0` → `Date.now()`; SQL ho z usageByDay/Model vyloučí (`ts IS NOT NULL`) → kompakce přesune jeho tokeny k dnešku. Záměr je částečně dokumentovaný (komentář `:160`), ale důsledek "kompakce mění historické součty" nikde popsán není. Reálná PI data timestamp mají vždy — legacy hrana.
- **Reconcile neopraví 'running' řádek s rozbitou relací** [k3] — `getSubagentRuns` join vyžaduje `c.user_id = p.user_id` (`brainDelegationStore.ts:305-311`); řádek s převlastněným childem reconcile nepřečte a zůstane `running` navždy, maskovaný display filtrem. Prakticky nedosažitelné; jeden `UPDATE` fallback by to uzavřel.
- **Tichý drop v `pendingSubagentResults`** [k3] — ne-objekt payload se dropne bez logu (`brainDelegationStore.ts:545-551`), write strana loguje hlasitě. Komentář drop zdůvodňuje, ale `log.warn` by neuškodil.
- **WhatsApp obrázky ztratily quote trigger zprávy** [k3] — `plugins/whatsapp/lib/stream.mjs:30` volá `sendImages(jid, data)` bez `quoted`, který adapter dál přijímá (`adapter.mjs:694-696`) a dřív dostával. Text quotuje vždy. Kosmetická regrese.
- **Mrtvá koerce `--memory` + test falešné jistoty** [oba] — `headless.ts:234` tiše koercuje nevalidní memory na `'skip'`, ale `runHeadlessSetup` (`:25-28`) umírá přes `die()` dřív → koerce je mrtvá a test `headless.test.ts:84-87` testuje chování, které produkce nikdy nevykoná. Smazat koerci, přepsat test na `die()`.
- **OAuth dialog restartuje poll při každém renderu rodiče** [oba] — `BrainSection.tsx:81` má v deps nestabilní `onDone` (inline closure `:574`); rateLimits refetch každých 20s (`queries.ts:351-359`) efekt shodí a resetuje timer. Self-healing (další poll doběhne), fix je `useCallback`.
- **Díra v invalidačním guardu (latentní)** [k3] — `elowenClientSurface.test.ts:140-155`: `invalidateQueries({ queryKey: someVar })` se započítá jako read site, key heads z proměnné dají `[]` → tiše projde bez kontroly klíče. Dnes jí nic neprotéká (jediný shorthand call site je počítaný jako nečitelný); první budoucí variabilní klíč projde. Invalidaci bez extrahovatelného head má test shodit.
- **E2E temp adresáře leakují při tvrdém pádu** [oba] — `workflow-e2e/model.mjs:369` a `delegate-e2e/run.mjs:283` uklízí ve `finally` za `daemon.stop()`; SIGKILL/OOM leakne `elowen-wf-e2e-*` v /tmp. Daemon dataDir má exit hook, uzly by mohly psát pod něj.
- **`actionableNodeError` matchuje první výskyt id** [k3] — `workflow.mjs:77`; u duplicitního id ukáže hláška na první uzel. Vzácné, kosmetické.

## Zamítnuté / neobstály

- **Qwen NIT: boot reconcile trvale persistuje ořezaný workflow snapshot** — qwen sám označil za nízkou jistotu a pravděpodobně pre-existing; mechanismus (strip `sessionId` nevalidních childů v `getWorkflowRuns`) se tímto rozsahem nezměnil, jen se sweep přesunul z lazy na boot. V recenzovaném diffu žádná regrese.
- **Qwen: "boot reconcile je bezpečný, žádné živé delegace neexistují"** — platí jen pro single instance; multi-instance scénář (should-fix #1) qwen přehlédl a výsledek "verified OK" byl příliš optimistický.
- **Qwen: "parse gate je před side-effectem"** — neplatí pro `bringUp`, viz should-fix #2.
- **K3: reconcile jako BLOCKER** — po ověření sníženo na should-fix: dopad je dočasný (řádky se samy zahojí last-write-wins), trvalý je jen falešný "interrupted" výsledek v transkriptu, a scénář vyžaduje druhou instanci nad stejnou DB.
- **Web-qwen NIT: dvojí "uloženo" toast v ProjectEditoru** — neověřeno, kosmetické; zahozeno jako nedoložené.
- **TOCTOU mezi `realAbs` a `readFileSync` (nodesFile)** [k3] — stejná akceptovaná třída jako u Read/plan file, dopad max pár znaků cizího souboru v chybové hlášce. Není nález.

## Srovnání modelů

- **k3** byl silnější na concurrency, lifecycle a operační scénáře: našel všechny těžké should-fixy (reconcile vs. druhá instance, bringUp restart, down na non-Linuxu, 5s budget, queue reorder, baseline clobber, stopSubagent ALS). Slabina: dvakrát špatně lokalizoval (stopSubagent bug je na `:356`, ne `:819`) a reconcile nadsadil na blocker.
- **qwen** byl silnější na detailní čtení SQL a okrajové vstupy: jako jediný našel chybějící `json_type` guard v `tokenTotals` a prázdný `--admin-pass=`. U rollup timestampu správněji poznal dokumentovanou volbu, kde k3 viděl bug. Slabina: dvě jeho "verified OK" konstatování neobstála (reconcile multi-instance, parse gate pořadí) — u věcí, které sám označil za ověřené, měl tendenci potvrzovat příliš rychle.
- **Systematické mezery:** k3 přehlíží drobné edge-case vstupy (flagy, prázdné stringy); qwen přehlíží multi-instance/distribuované scénáře a pořadí side-effectů vůči validaci.
- **Křížová kontrola se vyplatila:** 6 nálezů našli oba nezávisle (všechny platí — vysoká spolehlivost shody), 2 přímé kontradikce se rozhodly čtením kódu (obě ve prospěch k3) a 5 platných nálezů by bez druhého modelu chybělo (tokenTotals, admin-pass, baseline clobber, down non-Linux, stopSubagent race).

## Verdikt

**Nasadit — blocker není; dev větev je v pořádku, ale should-fixy #1–#3 (daemon lifecycle) a #10–#11 (web data integrity) naplánovat co nejdřív, zbytek běžným tempem.**
