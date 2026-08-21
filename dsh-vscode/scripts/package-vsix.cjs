// Deterministic .vsix packager (drop-in for `vsce package`) that does not
// depend on @vscode/vsce (whose cheerio dependency hangs under Node 26).
// Mirrors vsce's extension.vsixmanifest / [Content_Types].xml layout.
"use strict";
const { readFileSync, existsSync, createWriteStream } = require("node:fs");
const { join, resolve } = require("node:path");
const { ZipFile } = require("yazl");

const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const files = [
  { archive: "extension/package.json", disk: join(root, "package.json") },
  { archive: "extension/README.md", disk: join(root, "README.md") },
  { archive: "extension/LICENSE", disk: join(root, "LICENSE") },
  { archive: "extension/dist/extension.js", disk: join(root, "dist/extension.js") },
];
for (const f of files) {
  if (!existsSync(f.disk)) throw new Error(`missing payload file: ${f.disk}`);
}

const esc = (s) =>
  String(s).replace(/(['"<>&])/g, (c) => ({ "'": "&apos;", '"': "&quot;", "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

const extensionKind = pkg.browser ? "workspace,web" : "workspace"; // `main` present, no `browser`

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
\t<Metadata>
\t\t<Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}"/>
\t\t<DisplayName>${esc(pkg.displayName ?? pkg.name)}</DisplayName>
\t\t<Description xml:space="preserve">${esc(pkg.description ?? "")}</Description>
\t\t<Tags></Tags>
\t\t<Categories>${esc((pkg.categories ?? []).join(","))}</Categories>
\t\t<GalleryFlags>Public</GalleryFlags>
\t\t<Properties>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}"/>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${extensionKind}"/>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value=""/>
\t\t\t<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
\t\t\t<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/>
\t\t\t<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
\t\t</Properties>
\t\t<License>extension/LICENSE</License>
\t</Metadata>
\t<Installation>
\t\t<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
\t</Installation>
\t<Dependencies/>
\t<Assets>
\t\t<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
\t\t<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
\t</Assets>
</PackageManifest>`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".js" ContentType="application/javascript"/></Types>`;

const out = join(root, `${pkg.name}-${pkg.version}.vsix`);
const zip = new ZipFile();
zip.addBuffer(Buffer.from(manifest, "utf8"), "extension.vsixmanifest");
zip.addBuffer(Buffer.from(contentTypes, "utf8"), "[Content_Types].xml");
for (const f of files) zip.addFile(f.disk, f.archive);

zip.outputStream.pipe(createWriteStream(out)).on("close", () => {
  const n = 2 + files.length;
  console.log(`wrote ${out} (${n} entries)`);
});
zip.end();