# Spanish glossary (POC localization, issue #137)

Authoritative EN to ES term list for UI strings and content names. Target variant: **neutral Latin-American Spanish**
(tuteo-free imperative forms such as "Elige", "Recupera"; avoid regionalisms and vosotros). Content names live in
`games/rpg/apps/web/src/i18n/catalogs/{en,es}/content.ts` and must agree with the proper-name tables below.

Conventions:

- Sentence case for UI labels ("Nueva aventura"); Title Case only for proper names of places, enemies and items.
- Stable IDs are never translated or renamed (ADR-0008); only display text is.
- Abbreviations stay as in English where Spanish gamers use them: **XP**, **HP** (alternative "PV" is rejected).
- Entries marked *pending owner review* are working names; the EN originals are themselves working names
  (region-1.md Q-C2).

## Core UI and game terms

| EN | ES | Notes |
|---|---|---|
| Sanctuary | Santuario | The hub settlement. Capitalised as a proper noun. |
| Expedition | Expedición | Umbrella for live and idle activity runs. |
| Live adventure | Aventura en vivo | Active mode. "New adventure" = "Nueva aventura". |
| Idle expedition | Expedición inactiva | Short form "Inactivo" for the mode label; "Idle" is not used. |
| Idle | Inactivo | Mode name. "Offline progress" = "Progreso sin conexión". |
| Run bag | Mochila de la expedición | Loot carried during a live run, banked on return. Short: "Mochila". |
| Conquest | Conquista | Region completion credit; verb "conquistar". Only live play grants it. |
| Area | Área | |
| Region | Región | |
| Location | Ubicación | Individual scene in an area. |
| Hub | Centro | Hub area type (Sanctuary). |
| Portal | Portal | |
| Fracture | Fractura | Proper noun in lore ("la Fractura"); lowercase when generic. |
| Ark | Arca | Evacuation ship. "Ark" as a proper noun: "el Arca". |
| Automation rules | Reglas de automatización | Ordered top-down rules for idle/auto play. |
| Rule | Regla | |
| Condition | Condición | |
| Loadout | Equipamiento de habilidades | Selected skills; short UI label "Habilidades equipadas". Not "Build". |
| Skill | Habilidad | |
| Cooldown | Enfriamiento | Short UI label; "Disponible en {n}" for remaining time. |
| Telegraph / windup | Aviso de ataque | Verb "se prepara". A telegraphed attack = "ataque telegrafiado" in tooltips only. |
| Guard | Guardia | Skill name and the defensive state. Verb "Guardia" (imperative: "Protégete"). |
| Taunt | Provocación | |
| Stun | Aturdimiento | Verb "aturdir". |
| Cleanse | Purificar | |
| Retreat | Retirada | Button: "Retirarse". Leaving a live run early. |
| Corpse | Cadáver | Button "Recuperar tu cadáver" (replaces "Recover your corpse"). |
| Death | Muerte | |
| Death penalty | Penalización por muerte | Also "pérdida por muerte" in compact UI. |
| Reserved supplies | Suministros reservados | Items held in escrow for an expedition; "en reserva" as adjective. |
| Escrow | Depósito en custodia | Technical docs only; do not show "escrow" in UI. |
| Merchant | Mercader | |
| Buy / Sell | Comprar / Vender | |
| Gold | Oro | Currency. |
| Storage | Almacén | Sanctuary storage. |
| Inventory | Inventario | |
| Equipment | Equipo | Equipped gear; equip = "Equipar", unequip = "Desequipar". |
| Level | Nivel | |
| XP | XP | Keep as XP. "Experience" spelled out = "Experiencia". |
| HP | HP | Keep as HP. |
| Estimate | Estimación | For idle projections; always paired with "aproximada" where space allows. |
| Hero / Character | Héroe / Personaje | "Personaje" in menus, "héroe" in narrative text. |
| Party | Grupo | Solo phase 1: not shown. |
| Boss / Mini-boss | Jefe / Minijefe | |
| Discovery | Descubrimiento | Locations discovered toward conquest. |
| Hotspot | Punto de interacción | Interact = "Interactuar con {name}". |
| Gather | Recolectar | Resource nodes. |
| Hunt | Cacería | Idle activity type. |
| Safe location | Ubicación segura | |
| Secret | Secreto | Secret locations are never shown as "missing". |
| Loot | Botín | |
| Damage / Heal | Daño / Curación | |
| Armor / Resist | Armadura / Resistencia | |
| Strength / Vitality | Fuerza / Vitalidad | Attribute names; keep consistent with the stats screen. |

## Proper names: areas and locations (pending owner review)

| EN | ES | Notes |
|---|---|---|
| Sanctuary Plaza | Plaza del Santuario | |
| The Verdant Hollow | La Hondonada Verde | Region 1. "Hollow" read as a sunken valley, not "hueco". Pending owner review. |
| Portal Clearing | Claro del Portal | |
| Overgrown Causeway | Calzada Cubierta de Maleza | |
| Old Well | Pozo Viejo | |
| Tangle Orchard | Huerto Enmarañado | |
| Glowcap Grotto | Gruta de los Hongos Luminosos | |
| Lantern Ruins | Ruinas de las Linternas | |
| Irrigation Terraces | Terrazas de Riego | |
| Pump Station | Estación de Bombeo | |
| Vault Antechamber | Antecámara de la Bóveda | |
| Sunken Greenhouse | Invernadero Sumergido | |
| Heart of the Seed Vault | Corazón de la Bóveda de Semillas | |
| The Shard Choir | El Coro de Esquirlas | Region 2 working name. Pending owner review. |
| Fracture Landing | Plataforma de la Fractura | |
| Signal Shallows | Bajíos de la Señal | |
| Prism Span | Puente Prismático | |
| Echo Archive | Archivo del Eco | |
| Resonance Court | Patio de Resonancia | |
| Choir Core | Núcleo del Coro | |
| Test Grove (technical seed) | Arboleda de Pruebas | Not player-facing in release. |

## Proper names: enemies, bosses, factions (pending owner review)

| EN | ES | Notes |
|---|---|---|
| Hollow Matriarch | Matriarca de la Hondonada | Region 1 mini-boss; native Fracture entity (not an Ark caretaker). |
| Glowcap Mite | Ácaro de Hongo Luminoso | |
| Thornback Boar | Jabalí Espinoso | |
| Hollow Creeper | Trepador de la Hondonada | |
| Sentinel Lantern | Linterna Centinela | Maintenance drone read as a "lantern spirit". |
| Rusted Tiller | Labrador Oxidado | Agricultural automaton, "cursed ploughman". |
| Glass Echo | Eco de Cristal | |
| Prism Guard | Guardia Prismático | |
| Resonant Warden | Custodio Resonante | Region 2 boss. |
| Warden | Custodio | Distinct from **Guardian** = Guardián (extraordinary Fracture entities, concept 2.4). |
| Guardian | Guardián | Reserved for lore Guardians; never use for Wardens. |
| Keepers of Sanctuary | Guardianes del Santuario | Working name; avoid clash with Guardián: prefer "Custodios del Santuario" if the owner keeps it. Pending. |
| Bulwark / Thornblade | Baluarte / Filospina | Reference builds (tank / striker). Pending owner review. |

## Skills, items and resources

Full lists are in the catalogs. Naming rules:

- Skills use short noun phrases or action nouns ("Golpe Aplastante", "Cornada", "Sanar").
- Region 1 "Verdant" maps to "Verde" ("Frenesí Verde").
- "Buckler" = Broquel; "Blade" = Hoja; "Tonic" = Tónico; "Potion" = Poción; "Scrap" = Chatarra; "Core" = Núcleo.
- "Choirglass Blade" = "Hoja de Cristal del Coro"; "Sapforged Blade" = "Hoja Forjada en Savia".
- "Heartwood" = "Duramen" (timber heartwood).

## Open points for the owner

- Hondonada Verde vs. a more literal "El Hueco Verdeante".
- Custodio (Warden) vs. Guardián (Guardian): confirm the two stay distinct.
- Loadout wording: "Habilidades equipadas" vs. a calque of "Loadout".
