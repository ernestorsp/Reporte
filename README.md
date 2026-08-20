# Reporte

Primera versión de la app semanal de reportes de drivers para DJX3 y DJX4, construida para Google Apps Script.

## Qué incluye esta versión

- Home con rankings por estación.
- Top drivers por categoría/puntos.
- Top 10 de complaints por estación.
- Top 5 de rescates recibidos por estación.
- Página independiente para DJX3 y DJX4.
- Selección individual o múltiple de drivers para enviar reportes.
- Check verde cuando el reporte ya fue enviado esa semana.
- Pantalla de carga con botón `+`.
- Estado amarillo para documentos pendientes y verde para documentos cargados.
- Lectura por nombre de encabezado, no por posición fija de columna.
- Soporte de CSV y XLS/XLSX (XLS/XLSX usa el servicio avanzado de Drive para convertir temporalmente a Google Sheets).
- Integración con `REPORTE APP > EMAIL` para emails.
- Integración con `LOG > INFRA_LOG` para CO, NCNS y Late Morning.
- Integración con `LOG > RESCUES_LOG` para rescates que afectan y rescates positivos.

## Fuentes semanales esperadas por estación

La app detecta estación, semana y tipo por el nombre del archivo.

- Overview: Overall Score y Packages Delivered.
- Safety: fecha + tipo de infracción.
- CDF: complaint + Feedback Details.
- DSB: solo filas con `Impacts Scorecard = 1`, guardando las categorías que afectan.
- PSB: solo `Failed Stops > 0`.
- DVIC: cualquier driver presente se considera inspección demasiado rápida.

## Sistema de puntos

- Packages Delivered: `packages * 0.15`
- Rescue recibido que afecta: `-(stops + packages) * 0.15`
- Rescue Positive: `+(stops + packages) * 0.15`
- Complaint: `-20`
- Safety infraction: `-50`
- DVIC: `-50`
- Late Morning: `-10`
- NCNS: `-20`
- CO: `-15`

Categorías:

- Fantastic: 100+
- Great: 70–99.99
- Fair: 20–69.99
- Poor: menos de 20

## Google Sheets usados

Los IDs ya están configurados en `Code.gs`:

- `REPORTE APP`: fuente de EMAIL y almacenamiento interno de la app.
- `LOG`: fuente de `INFRA_LOG` y `RESCUES_LOG`.

La app crea automáticamente tres pestañas ocultas en `REPORTE APP`:

- `_REPORT_DATA`
- `_UPLOADS`
- `_SEND_LOG`

No es necesario crearlas manualmente.

## Instalación en Apps Script

1. Crear un proyecto de Google Apps Script.
2. Copiar `Code.gs`, `Index.html` y `appsscript.json` al proyecto.
3. Confirmar que el servicio avanzado **Drive API v2** aparece habilitado.
4. Ejecutar una función una vez desde el editor para aceptar permisos de Sheets, Drive y envío de email.
5. Implementar como **Aplicación web**.
6. Ejecutar como el usuario que implementa la aplicación.
7. Elegir el nivel de acceso apropiado para tu operación.

## Importante

Esta es la primera versión funcional de la arquitectura. Antes de usar envíos masivos reales conviene probar una semana completa con archivos de DJX3 y DJX4 y validar especialmente:

- nombres/IDs de drivers que cambien entre fuentes,
- valores exactos usados en `Affects` para rescates positivos,
- encabezados de cualquier archivo nuevo de Amazon,
- reglas de asignación de eventos de `LOG` cuando un driver haya trabajado en ambas estaciones la misma semana.
