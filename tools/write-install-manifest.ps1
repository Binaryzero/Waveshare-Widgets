# Writes a release's own file list (#240) into each publish folder given, so a copy
# installed by extracting the zip can retire files a later release drops from its very
# first in-app update. The format InstallManifest.Serialize writes: its header line, then
# one relative path per line, each ending in a newline, without a byte-order mark.
#
# The updater never trusts a list it finds in an archive — it writes its own from what the
# archive ships — so this only seeds a fresh install. Run by release.yml before packing,
# and by build.yml, where tools/InstallManifest checks it reads back as the folder's files.
foreach ($dir in $args) {
  $root = (Resolve-Path -LiteralPath $dir).Path
  $files = Get-ChildItem -LiteralPath $root -Recurse -File |
    ForEach-Object { [System.IO.Path]::GetRelativePath($root, $_.FullName) } |
    Where-Object { $_ -ne 'install-manifest.txt' } |
    Sort-Object
  $text = "# Plinth install manifest v1`n" + (($files | ForEach-Object { "$_`n" }) -join '')
  [System.IO.File]::WriteAllText((Join-Path $root 'install-manifest.txt'), $text)
  Write-Output "install-manifest.txt: $(@($files).Count) file(s) in $dir"
}
