const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
async function main() {
  const archive = path.join(root,'release/win-unpacked/resources/app.asar')
  for(const entry of ['out/main/index.js','out/preload/index.js','out/renderer/index.html']) {
    const packed = asar.extractFile(archive,entry.split('/').join(path.sep))
    const built = await fs.readFile(path.join(root,entry))
    if(digest(packed)!==digest(built))throw new Error('Packaged build is stale: '+entry)
  }
  let verifiedBuildFiles=0
  async function verifyTree(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name)
      if(entry.isDirectory())await verifyTree(file)
      else {
        const relative=path.relative(root,file)
        if(digest(asar.extractFile(archive,relative))!==digest(await fs.readFile(file)))throw new Error('Packaged build is stale: '+relative)
        verifiedBuildFiles++
      }
    }
  }
  await verifyTree(path.join(root,'out'))
  const metadata = JSON.parse(asar.extractFile(archive,'package.json').toString())
  if(metadata.name!=='labdeck-competition-2026'||metadata.version!==JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version)throw new Error('Wrong application identity')
  const names = asar.listPackage(archive).map(name=>name.replace(/\\/g,'/'))
  if(names.some(name=>/^\/(artifacts|original-source-baseline|PROVENANCE)/.test(name)))throw new Error('Test files leaked into app archive')
  const name=`LabDeck Competition ${metadata.version}.exe`
  const file=await fs.readFile(path.join(root,'release',name))
  if(file.length<10_000_000||file[0]!==0x4d||file[1]!==0x5a)throw new Error('Invalid Windows executable')
  await fs.writeFile(path.join(root,'release/SHA256SUMS.txt'),digest(file)+'  '+name+'\n')
  const report={status:'passed',version:metadata.version,packagedEntryHashesMatch:true,verifiedBuildFiles,bytes:file.length,sha256:digest(file)}
  await fs.writeFile(path.join(root,'release/package-verification.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}
main().catch(error=>{console.error(error);process.exitCode=1})
