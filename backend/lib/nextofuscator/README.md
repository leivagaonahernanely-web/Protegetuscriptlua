# NextOfuscator (Ofuscador 4)

Copia compilada (JavaScript ES2022) del motor de `vanta-vs-protector` (`server/obfuscator/`),
commit `d022fdb`. Los imports llevan extensión `.js` para que Node los cargue sin compilar.

Para actualizarla desde el repo fuente:

```bash
cd vanta-vs-protector
tsc server/obfuscator/build.ts --ignoreConfig --outDir <destino> --module es2022 --target es2022 --moduleResolution bundler --skipLibCheck --rootDir server/obfuscator
# luego añadir .js a los imports relativos: sed -i -E 's#from "(\./[a-z]+)"#from "\1.js"#g' <destino>/*.js
```

Punto de entrada: `buildLua(source, seed)` de `build.js` (devuelve `{ code, segments }`).
Errores de sintaxis de Lua: `BuildError`.
