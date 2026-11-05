# Región 1 — Assets utilizables v1

Entrega de arte tras la aprobación de estilo de Claro del Portal, Terrazas de Riego y Corazón de la Bóveda de Semillas. Incluye las 11 ubicaciones, Max y los 6 enemigos de la Región 1, además del boceto de combate actualizado y un prototipo HTML de controles fijos.

## Exportación vigente de fondos

- Todos los fondos son **1086×1448 nativos, relación 3:4**, sin escalado ni recorte al exportar.
- `backgrounds/webp/`: **WebP con pérdida, calidad 85**, método 6.
- **PNG nativos originales** sin modificar: ya no viven en `public/` (se copia tal cual al build y a la imagen Docker). Están en `games/rpg/art/region-1/backgrounds/source/`. Un guard (`pnpm test`) falla si un PNG fuente o un WebP de más de 600 KB vuelve a `public/`.
- Los **8 fondos nuevos** pesan entre **273.638 y 427.380 bytes**, todos por debajo de **450.000 bytes**. Los tres fondos aprobados también están incluidos con la nueva exportación: Claro 394.760 bytes, Corazón 415.500 bytes y Terrazas 513.452 bytes. Este último conserva el PNG aprobado y Q85; no se alteró su arte para forzar el objetivo de los fondos nuevos.
- Cada fondo ocupa unos **6 MiB RGBA8 en GPU sin mipmaps**, independientemente de su peso de descarga. No cargar los PNG fuente de sprites como texturas de juego.

## Inventario de escenas

| Archivo | Nombre del glosario | Salidas / puntos de interés |
|---|---|---|
| portal-clearing | Claro del Portal | 1 ruta a la calzada; arco de portal y fogata apagada |
| overgrown-causeway | Calzada Cubierta de Maleza | 3 rutas; losa caída y hongos luminosos |
| old-well | Pozo Viejo | 3 rutas; toma de refrigerante, losa erosionada y hongos |
| tangle-orchard | Huerto Enmarañado | 3 rutas; árbol injertado y resina |
| glowcap-grotto | Gruta de los Hongos Luminosos | 1 retorno; dos zonas de hongos y anillo de búsqueda |
| lantern-ruins | Ruinas de las Linternas | 2 rutas normales y acceso secreto cerrado; panel agrietado y chatarra |
| irrigation-terraces | Terrazas de Riego | 3 rutas; árbol con resina y conjunto de válvulas |
| pump-station | Estación de Bombeo | 3 umbrales, uno cerrado; palanca y chatarra |
| vault-antechamber | Antecámara de la Bóveda | 2 umbrales; baliza de descanso y compuerta al jefe |
| sunken-greenhouse | Invernadero Sumergido | 1 acceso; reserva de semillas y registro del fundador |
| seed-vault-heart | Corazón de la Bóveda de Semillas | Sala cerrada, ninguna salida; espacio para el sprite del jefe |

Los IDs estables están en `manifest.json`. Las rutas/puntos se apoyan en el contenido vigente del repositorio; el arte no modifica la navegación. Las compuertas y la escotilla están representadas en un estado estático: al integrar, los indicadores y estados abiertos/cerrados deben proceder del servidor. Las coordenadas de interacción necesitan ajuste en el viewport real, especialmente cuando se recorta el fondo con `cover`.

No hay texto, flechas, iconos ni personajes incrustados en los fondos. Zonas propuestas tranquilas: 12% superior y 18% inferior. El portal es un objeto narrativo/de retorno, no añade una salida local al JSON. Las fuentes tienen la misma composición aprobada; los nombres se dibujan en la UI.

## Sprites y atlas

`sprites/` contiene un PNG RGBA y JSON de atlas independiente por personaje: `hero_max`, `glowcap_mite`, `thornback_boar`, `hollow_creeper`, `sentinel_lantern`, `rusted_tiller`, `hollow_matriarch`.

- Una pose neutra y un único frame `*_idle` por atlas; sin animación esquelética ni frames de ataque/golpe/muerte. Esos movimientos se realizan después con tweens del sprite completo.
- **512×512 RGBA8: 1 MiB por atlas sin mipmaps.** Los PNG pesan entre 140 y 317 KB. No hay fondos de damero pintados: alpha real verificado.
- Los originales transparentes de 1254×1254 se conservan en `games/rpg/art/region-1/sprites/source/`. Solo los sprites se redujeron al atlas de entrega por vecino más próximo; los fondos no se escalaron.
- Max mira a la derecha y los enemigos a la izquierda. Max conserva el aspecto del concepto; no define un sistema de personalización ni cambia el equipo real del personaje.
- La Matriarca es orgánica, nativa de la Fractura. Linterna Centinela y Labrador Oxidado son máquinas del Arca.
- Los JSON contienen un único frame sin trim/rotación; pivote propuesto, pendiente de ajustar en la escena. La compatibilidad de carga y los tweens se deben probar en el proyecto PixiJS; no se implementaron aquí.

## Mockup con controles fijos

- `docs/design/references/fixed-combat-reference.png` (movido fuera de `public/`): boceto actualizado. El arte y los textos dibujados son referencia visual, no componentes de UI reutilizables.
- **Abrir `mockup/index.html` después de descomprimir el paquete.** Funciona sin dependencias ni red, usando los fondos y sprites relativos.
- Baseline **360×780 CSS px**, filas reservadas para aviso de ataque, cola y feedback, habilidades 2×2 y poción/retirada siempre en sus filas. El log abre una capa superpuesta. Controles definidos con al menos 44 px de alto.
- Solo Max tiene controles; los cuatro marcos de grupo son una representación de la futura fase 2. Retirada bloqueada en el jefe, poción activa, Cleave con enfriamiento de 4s.
- `window.mockup.setState(...)` permite cambiar mensajes largos/vacíos para revisión. Este HTML es un prototipo local, no una integración de combate/cooperativo en el juego.

## Verificación y límites

Se comprobaron dimensiones, relación 3:4, límite de 2048 por lado, Q85, pesos, alpha, tamaños de atlas y referencias de archivos. Inspección visual de escenas y sprites a escala reducida. Comportamiento del HTML verificado con Happy DOM: selección en cola, enfriamiento deshabilitado conservado, Auto, consumo de poción, log y textos largos/vacíos.

**Geometría de navegador y teléfono pendiente:** Chromium no está instalado en este entorno; Happy DOM no valida medidas reales ni legibilidad física. No se afirma una prueba de PixiJS ni de dispositivo. El arte de cada escena está aplanado en un fondo opaco, con los personajes en archivos separados. Para parallax harán falta capas ambientales adicionales.

No se modificó código ni contenido del repositorio ni se publicó una integración. `generation.json` conserva los prompts y las referencias locales usados para esta tanda; `manifest.json` conserva dimensiones, hashes y presupuestos de los archivos entregados.
