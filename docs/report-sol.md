# Audit Elowen — gpt-5.6-sol

**Datum:** 28. 7. 2026  
**Větev:** `dev`  
**Rozsah:** 12 oblastí (`cli-chat`, zbytek CLI, brain core/service, API, store, daemon/overseer, sdílená infrastruktura, platformní pluginy, nástrojové pluginy, webové moduly a webové knihovny)

## Shrnutí

Repozitář má dobrou základní strukturu a v řadě oblastí důsledně používá typy, validaci cest a oddělené platformní hranice. Není ale v bezpečném stavu pro nedůvěryhodné víceuživatelské nasazení: největší rizika jsou sdílená identita agentů, neomezená těla veřejných requestů a práce s nevalidovaným ID v cestách worktree. Napříč backendem, pluginy i webem se opakuje stejný vzorec: asynchronní teardown nebo starší odpověď změní autoritativní stav bez zámku, generace či transakce. Několik těchto závodů může zanechat živého osiřelého agenta, smazat rozpracovanou práci nebo přepsat novější uživatelský vstup. Mrtvý kód a god files jsou proti tomu vedlejší údržbový dluh.

## Kritické nálezy

1. **Sdílený agent token porušuje izolaci uživatelů a projektů.**  
   **Místo:** `src/daemon/bootstrap.ts:325-342`, `src/api/context.ts:125-162`, `src/api/middleware.ts:28-49`, `src/api/routes/tasks.ts:56-67`, `src/api/routes/tasks.ts:203-227`, `src/api/routes/missions.ts:125-153`  
   Workeři, piloti a overseery používají stejný token a jeho oprávnění se skládají ze všech aktivních projektů. Kompromitovaný nebo chybný agent proto může číst a měnit cizí úlohy nebo odpovědět na rozhodnutí jiné mise; route navíc nevynucují vazbu tokenu na konkrétní task či mission. **Oprava:** vydávat tokeny s claims `taskId`/`missionId`/`projectId` a rolí, na každé route ověřovat vlastnictví a agentům povolit jen úzce definované přechody vlastního objektu.

2. **Veřejný request může vyčerpat paměť daemonu.**  
   **Místo:** `src/api/server.ts:20-36`, `src/api/validation.ts:9-10`, `src/api/routes/auth.ts:41-45`, `src/api/routes/hooks.ts:23-26`  
   Login a webhook načtou celé JSON nebo `arrayBuffer()` před účinným limitem. Chunked request nebo falešný `Content-Length` tak může způsobit OOM a pád procesu. **Oprava:** zavést tvrdý streamující limit v serverovém adaptéru ještě před parsováním, jednotně pro JSON, multipart i webhooky.

3. **Task ID lze použít k úniku worktree mimo určený adresář.**  
   **Místo:** `src/api/schemas/tasks.ts:4-13`, `src/api/routes/tasks.ts:69-75`, `src/overseer/missionEngine.ts:68-74`, `src/overseer/missionGit.ts:71-77`  
   Libovolný řetězec z `id` vstupuje přes `join()` do cesty worktree. Hodnota s `../` může v PR režimu vytvořit worktree na jiné zapisovatelné cestě a cleanup ji následně odstranit přes `git worktree remove --force`. **Oprava:** omezit ID bezpečným regulárním výrazem, pro název adresáře použít hash/sanitizovaný segment a po `resolve()` ověřit, že cesta zůstala pod pevným rootem.

4. **Pozastavení PR mise nevratně maže rozpracované změny.**  
   **Místo:** `src/overseer/missionEngine.ts:195-202`, `src/overseer/missionGit.ts:294-301`, `src/integrations/git/worktree.ts:32-42`  
   Pause ukončí agenta, vrátí task na `open` a odstraní worktree s `--force`; necommitnutá práce právě běžící fáze se ztratí. **Oprava:** při pause worktree ponechat, nebo před odstraněním vytvořit ověřený checkpoint a při resume jej obnovit.

5. **Dokončení uložení souboru zahodí novější rozepsané změny.**  
   **Místo:** `web/modules/projects/editor/ProjectEditor.tsx:136-143`, `web/lib/mutations.ts:423-437`, `src/api/routes/projects.ts:126-131`  
   Po odeslání save může uživatel dál psát; pozdější `onSuccess` staršího požadavku bez porovnání vyčistí aktuální draft a přepíše cache starším obsahem. **Oprava:** verzovat nebo serializovat zápisy, draft čistit jen pokud se stále rovná odeslanému obsahu a na backendu použít hash/ETag precondition.

6. **Destruktivní routy mažou autoritativní stav i po neúspěšném teardownu.**  
   **Místo:** `src/api/routes/tasks.ts:408-438`, `src/api/routes/tasks.ts:442-457`, `src/api/routes/projects.ts:69-90`, `src/tmux/driver.ts:82`  
   Chyby z `disengage`, `tmux.kill` a cleanupu se spolknou a databázový záznam zmizí, i když worker, overseer nebo worktree zůstane aktivní. Systém tím ztratí možnost živý proces spolehlivě přiřadit a řídit. **Oprava:** ignorovat jen ověřený stav „už neexistuje“, ostatní chyby propagovat; smazání dokončit až po potvrzeném teardownu nebo objekt převést do perzistentního stavu `deleting` a dokončit jej reconcilerem.

## Vážné nálezy

1. **Smazání tasku během startu může zanechat živého osiřelého agenta.**  
   **Místo:** `src/api/services/sessionService.ts:43-62`, `src/api/routes/tasks.ts:398-438`, `src/overseer/janitor.ts:17-25`  
   DELETE může proběhnout mezi změnou stavu a skutečným spawnem; následný spawn přesto uspěje a janitor session bez tasku neukončí. **Oprava:** launch, cancel a delete serializovat per-task zámkem nebo generační lease a po spawnu znovu atomicky ověřit existenci a stav tasku.

2. **PATCH tasku validuje část vstupu až po mutaci a side effectech.**  
   **Místo:** `src/api/routes/tasks.ts:211-260`  
   Stav, SSE a review mohou proběhnout dřív, než se odmítne neplatné `exec`, `addDep` nebo `parent_id`; klient dostane `400`, ale task už je změněný. **Oprava:** nejdřív validovat celý příkaz a oprávnění, poté provést jednu transakci a side effecty publikovat až po commitu.

3. **Vytvoření tasku se závislostmi a batch purge nejsou atomické.**  
   **Místo:** `src/api/routes/tasks.ts:74-76`, `src/store/taskStore.ts:145-151`, `src/api/routes/memory.ts:81-89`, `src/store/memoryStore.ts:208-217`  
   Chyba uprostřed nechá task bez deklarovaných závislostí nebo nevratně smaže jen prefix batch dávky. **Oprava:** obě operace obalit jednou store transakcí a publikovat události až po úspěšném commitu.

4. **Mission API přijímá ne-epic task a neomezené `maxSessions`.**  
   **Místo:** `src/api/routes/missions.ts:53-66`, `src/api/schemas/missions.ts:5-9`, `src/api/schemas/tasks.ts:49-63`, `src/overseer/missionEngine.ts:252-271`  
   Mise bez potomků se nedokončí; nula či záporné číslo ji zastaví a extrémní hodnota může spustit nekontrolované množství agentů. **Oprava:** vyžadovat `type === "epic"` a stanovit rozumný celočíselný rozsah `maxSessions`.

5. **Chyba commitu je zaměněna za čistý worktree.**  
   **Místo:** `src/overseer/missionGit.ts:90-102`, `src/api/services/reviewService.ts:121-135`, `src/api/services/reviewService.ts:175-183`  
   `commitPhase()` vrací `false` jak pro nulové změny, tak pro chybu; caller výsledek ignoruje a může pokračovat až k PR bez dokončené práce. **Oprava:** vracet rozlišený stav `clean | committed | failed` a při `failed` misi zablokovat.

6. **Tmux spawn není transakční.**  
   **Místo:** `src/tmux/driver.ts:23-27`, `src/overseer/scheduler.ts:84-91`, `src/overseer/missionEngine.ts:326-335`  
   Po úspěšném `new-session` může selhat `send-keys`; session zůstane osiřelá, zatímco task se vrátí na `open` a další pokus narazí na duplicitu. **Oprava:** při selhání druhého kroku novou session spolehlivě uklidit a chybu zachovat.

7. **Mazání brain session závodí se spawnem, turnem a delegacemi.**  
   **Místo:** `src/brain/brainService.ts:853-869`, `src/brain/brainService.ts:983-1004`, `src/brain/service/lifecycle.ts:247-323`, `src/brain/session/factory.ts:235-255`  
   Delete nepoužívá stejné zámky jako send/spawn a ukončí jen shell procesy; session se může po potvrzeném smazání znovu zaregistrovat nebo po ní mohou dál běžet odpojené delegace/workflow. **Oprava:** serializovat delete stejným session zámkem, zavést generační fence a teardown celé podřízené runtime struktury dokončit před odstraněním store záznamů.

8. **Brain worker zaměňuje různé tasky a nebrání souběžnému spawnu.**  
   **Místo:** `src/brain/worker/brainWorker.ts:143-148`, `src/brain/worker/brainWorker.ts:218-237`  
   Idempotence porovnává jen `agentName`; druhý task stejného agenta může dostat úspěch bez workeru. Dva paralelní požadavky navíc mohou vytvořit dvě session a jednu ztratit z registru. **Oprava:** identitu vázat na task/job ID a rezervaci workeru provést atomicky před asynchronním spawnem.

9. **LSP operace mohou použít jiný projekt nebo diagnostiku jiné verze dokumentu.**  
   **Místo:** `src/brain/tools/lspTools.ts:37-44`, `src/lsp/manager.ts:263-280`, `src/lsp/client.ts:180-190`, `src/lsp/client.ts:254-276`, `src/lsp/client.ts:373-391`  
   Workspace symbol vybírá root podle délky názvu místo aktuálního workdir; současný hover/change může diagnostice podstrčit výsledek pro jiný obsah. **Oprava:** root odvodit z aktuálního povoleného projektu a všechny operace nad jedním URI serializovat nebo párovat s verzí dokumentu.

10. **Poškozený uložený JSON shodí celé přehledy a drain workflow.**  
    **Místo:** `src/store/brainStore.ts:215-220`, `src/store/brainUsageStore.ts:15-47`  
    SQLite `json_extract/json_each` bez `json_valid` selže na jediném malformed message; platné JSON `null` zase projde parsováním workflow payloadu a následný přístup k vlastnosti vyhodí `TypeError`. **Oprava:** při zápisu validovat tvar a čtení chránit `json_valid`, typovou kontrolou a izolací vadného záznamu.

11. **Externí embedding může tiše vyřadit paměťové vyhledávání.**  
    **Místo:** `src/embeddings/embeddingService.ts:112-119`, `src/brain/memoryService.ts:92-105`, `src/brain/memoryService.ts:156-166`  
    Prázdný vektor, `NaN` nebo nekonečno projdou hranicí, cosine vrátí neplatné skóre a keyword fallback se neaktivuje. **Oprava:** požadovat neprázdný vektor správné dimenze se samými konečnými čísly a vadnou odpověď klasifikovat jako chybu provideru.

12. **Reload pluginů může zduplikovat cron a osiřit delegace či workflow.**  
    **Místo:** `plugins/cronjob/index.mjs:397-426`, `src/brain/platforms.ts:278-281`, `plugins/subagent/index.mjs:152-168`, `plugins/subagent/index.mjs:255-260`, `plugins/subagent/lib/workflow.mjs:73-101`, `plugins/subagent/lib/workflow.mjs:409-425`  
    Starý tick doběhne souběžně s novým adaptérem; subagent stav je jen v closure mapách a po reloadu ovládací nástroje běhy nenajdou. Background workflow navíc nemá stop ani timeout. **Oprava:** asynchronní reload barrier, sdílený claim/mutex, perzistentní nebo přenesený runtime registr a explicitní cancel/timeout.

13. **Updater nemá jednotný zámek ani trvalý stav odloženého restartu.**  
    **Místo:** `src/api/routes/config.ts:178-184`, `src/api/version.ts:30-36`, `src/cli/update.ts:106-138`, `src/cli/autoUpdate.ts:23-43`  
    Více updaterů může souběžně přepisovat globální instalaci; po instalaci může být restart odložen a už nikdy neproběhnout. Kontrola navíc chrání mise, ne živé chatové tahy a shell procesy. **Oprava:** cross-process lock přes kontrolu, instalaci i restart, perzistentní `restart pending` a jednotná kontrola quiescence všech běhů.

14. **Asynchronní webové odpovědi přepisují novější lokální stav.**  
    **Místo:** `web/modules/account/AccountView.tsx:167-185`, `web/modules/settings/BrainSection.tsx:54-66`, `web/modules/settings/BrainSection.tsx:88`  
    Refetch profilu může během debounce přepsat formulář; zrušený OAuth polling může později znovu změnit stav na „připojeno“. **Oprava:** seedovat formulář jen před první uživatelskou změnou, požadavky verzovat a polling ukončovat přes `AbortController`/generation guard.

15. **CLI může během restartu spustit druhý, neřízený daemon.**  
    **Místo:** `src/cli/index.ts:105-112`, `src/cli/launcher.ts:157-185`, `src/daemon/index.ts:81-97`  
    Jediný neúspěšný health check vede k detached spawnu mimo existující start lock a správce služby. Proces může obsadit port před systemd a rozbít restart nebo IP režim. **Oprava:** v řízené instalaci startovat jen přes správce služby; standalone cesta musí používat stejný cross-process start lock.

16. **Teams limit přílohy se kontroluje až po načtení celého těla.**  
    **Místo:** `plugins/msteams/lib/adapter.mjs:260-277`, `plugins/msteams/lib/connector.mjs:124-130`  
    `arrayBuffer()` stáhne libovolně velkou odpověď před kontrolou `maxImageBytes`, takže velká příloha může vyčerpat paměť daemonu. **Oprava:** předběžně kontrolovat `Content-Length` a současně streamovat s tvrdým byte limitem a abortem.

## Mrtvý kód

### Nikdo nevolá vůbec

- `src/cli/install/runner.ts:16`, `src/cli/install/runner.ts:43` — `Runner.exists` nemá produkčního ani testovacího volajícího; jen zatěžuje testovací implementace rozhraní.
- `src/cli/client.ts:17` — `ElowenClient.engage()` nemá volajícího v `src/`, `web/`, pluginech ani testech.
- `src/cli/chat/chatComposition.ts:1234` — větev `case 'leader'` je nedosažitelná, protože `src/cli/chat/keys.ts:247-250` tuto akci před dispatcherem vyřazuje.
- `plugins/msteams/lib/format.mjs:13-18`, `plugins/msteams/index.mjs:12` — `buildReplyContext` a jeho reexport nikdo nepoužívá.
- `web/lib/elowenClient.ts:61-63`, `web/lib/useElowenEvents.ts:96` — wrappery `getMissionDetail`, `missionChangedFiles` a invalidace neexistující query nemají konzumenta.
- `web/modules/tasks/PhaseLogRow.tsx:29`, `web/modules/settings/PluginConfigEditor.tsx:368`, `web/modules/timeline/TimelineView.tsx:57` — exportované typy jsou použity pouze uvnitř vlastního souboru; mrtvý je export, ne lokální typ.

### Volá jen test

- `src/cli/install/preflight.ts:12-15`, `src/cli/install/preflight.ts:34` — `PreflightResult.buildTools` čtou jen testy; produkce kontrolu později opakuje.
- `src/cli/client.ts:14` — `ElowenClient.createTask()` používá pouze test. Jde o produkčně nevyužitou veřejnou plochu, ne kód bez jediného volajícího.
- `src/brain/processRegistry.ts:191-196` — `runningCount()` používají testy; bez rozhodnutí o veřejném kontraktu jej nelze automaticky smazat.

## Duplikace

1. **Parsování CLI flagů:** `src/cli/index.ts:120-126`, `src/cli/install/index.ts:235-238`, `src/cli/setup/headless.ts:202-210`. Implementace stejného pravidla už driftují a installer může spolknout následující flag. **Sloučení dává smysl** do jednoho parseru sdíleného CLI balíčkem.
2. **Čekání na daemon:** `src/cli/index.ts:105-113`, `src/cli/install/index.ts:62-70`, `src/cli/setup/command.ts:101-107`. Tři definice „healthy“ mají jiné timeouty a zacházení s HTTP chybou. **Sloučení dává smysl** do jedné omezené health-check utility.
3. **Normalizace provider usage:** `src/brain/openaiCodexUsage.ts:24-32` versus kontrakt `src/brain/providerUsage.ts:53-67` a obdobné Anthropic/Kimi normalizátory. OpenAI jako jediný přijme `windows: []` a přepíše last-good cache. **Sloučení dává smysl** alespoň pro společnou strukturální validaci; provider-specific mapování má zůstat oddělené.
4. **WhatsApp live engine:** `plugins/whatsapp/lib/stream.mjs:62-232` duplikuje lifecycle z `plugins/_shared/liveMessage.mjs:171-435` a už se liší v settle i answer mode. **Sloučení dává smysl**: transport nechat lokální, stavový engine vrátit do `_shared`.
5. **Webové DTO:** `web/lib/types.ts:1-25`, `web/lib/types.ts:148-154`, `web/lib/types.ts:224-260` ručně zrcadlí typy z `src/store/types.ts`, `src/overseer/sessionInfo.ts`, `src/brain/processRegistry.ts`, `src/store/userStore.ts` a dalších. **Přímý runtime import z `src/` smysl nedává**, ale dává smysl generovaný kontrakt nebo samostatný type-only balíček; současný drift už zasáhl `/auth/me`.
6. **Projektové akce ve webu:** `web/modules/projects/ProjectsView.tsx:64-79`, `web/modules/projects/ProjectsView.tsx:94-103`. Open/Edit/Copy/Remove jsou definovány zvlášť pro dvě menu. **Sloučení dává smysl** do jedné datové definice akcí, protože se mění společně.

## God files

- `src/brain/brainService.ts:117-1615` — jedna třída vlastní abort, client lifecycle, mazání a rekey session, delegace, process API i plugin reload. Nezávislé teardown větve už driftují; nejde jen o velikost.
- `src/cli/chat/chatComposition.ts:294-1420` — composition root současně vlastní render přípravu, overlay geometrii, notice timery, queue/interrupt stav, editor handlery, keybind dispatcher a cleanup.
- `web/app/settings/page.tsx:105-1148` — jedna komponenta spojuje modely, providery, autopilota, GitHub, systém, retenci, logy a mazání dat včetně nezávislých draftů, autosave a dialogů.

Rozdělení má následovat lifecycle a doménové hranice, ne mechanický počet řádků. Refaktor by měl přijít až po opravě funkčních vad a být krytý testy současného chování.

## Co nechat být

- `src/daemon/bootstrap.ts` je velký, ale převážně composition root; samotná velikost z něj god file nedělá.
- `src/cli/install/index.ts` je rozsáhlý, ale drží jednu instalační orchestraci. Opravit je potřeba konkrétní parser a health-check drift, ne soubor automaticky rozsekat.
- Velké platformní adaptéry v `plugins/` zůstávají na jedné transportní hranici. Izolace pluginů je záměrná; neslučovat doménově odlišné adaptéry jen kvůli podobnému tvaru.
- `web/` nesmí za běhu importovat `src/`. Duplicitní wire typy řešit generováním nebo type-only kontraktem, ne porušením této hranice.
- `ProcessRegistry.runningCount()`, `ElowenClient.createTask()` a podobné test-only plochy nejsou automaticky mrtvé. Nejprve rozhodnout, zda jsou součástí zamýšleného veřejného kontraktu.
- `registerSystemPromptFragment` není potvrzená capability díra: dokumentovaný `mutates` se vztahuje na runtime hook patches a bundled pluginy používají statické fragmenty.
- V nástrojových pluginech nebyl potvrzen path traversal; cesty jsou vedené přes `ctx.assertPathAllowed`. Tuto ochranu neobcházet kvůli zjednodušení kódu.

## Doporučené pořadí prací

1. **Uzavřít bezpečnostní hranice:** per-agent claims, kontrola vlastnictví, streamující body limity a bezpečné task/worktree ID. **Riziko změny: vysoké**, protože zasahuje auth a veřejné API. **Ověření:** negativní cross-tenant integrační testy, role/task matrix, chunked oversized request, traversal payloady a kontrola, že žádná cesta neopustí worktree root.
2. **Zavést jednotný lifecycle pro destruktivní operace:** per-task/session lease, stav `deleting`, přesný tmux teardown a reconciler osiřelých procesů. **Riziko: vysoké.** **Ověření:** deterministické race testy delete-versus-spawn/send, fault injection na `kill`/cleanup a kontrola DB, registru procesů i skutečných tmux sessions po chybě.
3. **Odstranit ztrátu uživatelských dat:** bezpečný pause/resume worktree a verzované ukládání editoru. **Riziko: střední až vysoké.** **Ověření:** end-to-end pause uprostřed necommitnuté změny a UI test, kde uživatel píše během pomalého save; novější obsah musí vždy zůstat.
4. **Zpevnit task/mission transakce a state machine:** validace před mutací, atomické dependencies/purge, omezení `maxSessions`, rozlišení chyby commitu a CAS přechody stavů. **Riziko: střední až vysoké.** **Ověření:** rollback testy při každém mezikroku, souběžné status změny a mise s nulovými, extrémními a ne-epic vstupy.
5. **Opravit lifecycle pluginů a updateru:** reload barrier, cancel/timeout workflow, sdílené claims pro cron, update lock a `restart pending`. **Riziko: střední.** **Ověření:** reload během aktivního ticku/delegace, dva souběžné update požadavky a odložený restart při aktivním tahu bez duplicitního spuštění či ztráty výsledku.
6. **Teprve potom odstranit drift a údržbový dluh:** sjednotit CLI parser/health-check, sdílenou validaci usage, WhatsApp live engine a generování DTO; odstranit potvrzený dead code a po lifecycle hranicích rozdělit tři god files. **Riziko: nízké až střední.** **Ověření:** cílené regresní testy každého kontraktu, `knip`/TypeScript/lint, relevantní test suites a finální kontrola importních hranic `web/` versus `src/`.

## Omezení auditu

- Audit byl statický a read-only; podle zadání se nespouštěl build, testy ani reálné platformní end-to-end scénáře. Návrhy ověření proto nejsou tvrzením, že už příslušné testy procházejí.
- Neprohlížely se `node_modules/`, `dist/`, `web-dist/`, `.next/` ani `benchmark-env/`.
- Výstupy dvanácti závislých analýz byly syntéznímu kroku předány zkrácené. Vybrané kritické a vážné závěry byly znovu cíleně ověřeny read-only průzkumem, ale všechny nízko prioritní položky z původních analýz nebylo možné znovu zahrnout; zpráva proto není vyčerpávající katalog.
- Nebyla ověřena konkrétní produkční topologie proxy, tenantů, systemd ani externích platforem. Některé dopady (Teams, OAuth, update/restart) je nutné potvrdit v odpovídajícím provozním prostředí.
- Worktree už před auditem obsahoval nesouvisející změny v `src/api/schemas/config.ts`, `src/brain/session/toolResultClearing.ts`, `src/daemon/bootstrap.ts`, `src/store/configStore.ts`, `web/lib/types.ts` a `web/modules/settings/BrainLimitsModal.tsx`; audit je neměnil ani neposuzoval jako vlastní diff.
