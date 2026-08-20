# Reporte App - Firebase

Esta carpeta contiene la nueva version de la app basada en Firebase.

## Arquitectura

- Firebase Hosting: interfaz web.
- Firebase Authentication: acceso con Google.
- Firebase Storage: archivos originales por semana/estacion/tipo.
- Cloud Functions: valida CSV/XLS/XLSX y normaliza datos en segundo plano.
- Firestore: estados de carga y registros normalizados para historicos/reportes.

Ruta de archivos:
`weekly/{week}/{station}/{type}/{timestamp_filename}`

Ejemplo:
`weekly/2026-W33/DJX4/SAFETY/1720000000000_safety.xlsx`

## Documentos requeridos por estacion

OVERVIEW, SAFETY, CDF, DSB, PSB, DVIC.

Cada archivo se valida por encabezados de la primera fila, no por posicion de columna.

## Preparacion inicial

1. Crear un proyecto en Firebase Console.
2. Activar Firestore Database.
3. Activar Storage.
4. Activar Authentication > Google.
5. Activar Functions/Blaze si Firebase lo requiere para desplegar funciones.
6. Crear una Web App y copiar su firebaseConfig.
7. Reemplazar los valores REPLACE_ME en `public/app.js`.
8. Desde esta carpeta ejecutar:
   - `firebase login`
   - `firebase use --add`
   - `cd functions && npm install && cd ..`
   - `firebase deploy`

## Flujo semanal

1. Seleccionar semana, por ejemplo 2026-W33.
2. Entrar con Google.
3. Hacer clic en el slot exacto, por ejemplo SAFETY DJX4.
4. Elegir el archivo.
5. El navegador lo sube directamente a Storage.
6. La Cloud Function valida y procesa en segundo plano.
7. Firestore cambia el estado a processing, loaded o error.
8. La interfaz refleja ese estado en tiempo real sin bloquear toda la app.

## Datos

`uploads/{week_station_type}` mantiene el estado del documento.

`records` contiene filas normalizadas con:
- week
- station
- sourceType
- driverKey
- driverName
- transporterId
- kind
- date
- label
- extra

Esto permite acumular todas las semanas y construir rankings por semana, mes o rango de fechas sin volver a leer los archivos originales.
