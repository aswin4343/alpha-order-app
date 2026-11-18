import { importFullProducts } from './excel.mjs'
const list = await importFullProducts({ arrayBuffer: async () => new ArrayBuffer(0) })
process.stdout.write(JSON.stringify(list))
