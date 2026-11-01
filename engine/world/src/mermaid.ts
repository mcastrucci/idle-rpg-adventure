/**
 * Mermaid export of the world map and area graphs (world-model §7), for docs and content review.
 */
import { describeRequirement } from './requirements.ts';
import { SECRET_TAG, type Area, type Location, type Requirement, type World } from './schemas.ts';

/** World map: hubs as circles, other areas as boxes, routes labelled with their requirement. */
export function worldToMermaid(world: World): string {
  const lines = ['graph LR'];
  for (const area of world.areas) {
    const label = quote(`${area.id}<br/>${area.kind}`);
    lines.push(area.kind === 'hub' ? `  ${nodeId(area.id)}((${label}))` : `  ${nodeId(area.id)}[${label}]`);
  }
  for (const route of world.routes) {
    const parts = [route.id, ...(route.travel.mode === 'timed' ? [`timed ${route.travel.durationMin}min`] : [])];
    lines.push(`  ${nodeId(route.from)} -- ${edgeLabel(parts, route.requires)} --> ${nodeId(route.to)}`);
  }
  return lines.join('\n') + '\n';
}

/** Area graph: start location as a circle, secret-tagged locations/exits styled as secret (dotted edges). */
export function areaToMermaid(area: Area, locations: readonly Location[]): string {
  const byId = new Map(locations.map((loc) => [loc.id, loc]));
  const own = area.locations.map((id) => byId.get(id)).filter((loc): loc is Location => loc !== undefined);
  const lines = ['graph TD', '  classDef secret stroke-dasharray: 4 4'];
  for (const loc of own) {
    const label = quote(loc.tags.length > 0 ? `${loc.id}<br/>${loc.tags.join(', ')}` : loc.id);
    const shape = loc.id === area.startLocation ? `((${label}))` : `[${label}]`;
    const cls = loc.tags.includes(SECRET_TAG) ? ':::secret' : '';
    lines.push(`  ${nodeId(loc.id)}${shape}${cls}`);
  }
  for (const loc of own) {
    for (const exit of loc.exits) {
      const label = edgeLabel([exit.id], exit.requires);
      const arrow = exit.tags.includes(SECRET_TAG) ? `-. ${label} .->` : `-- ${label} -->`;
      lines.push(`  ${nodeId(loc.id)} ${arrow} ${nodeId(exit.to)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function edgeLabel(parts: readonly string[], requires: Requirement | undefined): string {
  const all = requires ? [...parts, `requires ${describeRequirement(requires)}`] : parts;
  return quote(all.join('<br/>'));
}

/** Mermaid node IDs must be plain identifiers. */
function nodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function quote(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}
