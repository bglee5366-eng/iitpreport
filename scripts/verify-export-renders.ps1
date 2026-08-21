param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [Parameter(Mandatory = $false)][string]$Pdf,
  [string]$OutputDir = "tmp\export-render"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputPath = if ([IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $repoRoot $OutputDir }
New-Item -ItemType Directory -Force $outputPath | Out-Null

$python = $env:CODEX_PYTHON
if (-not $python) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
$renderDocx = "C:\Users\user\.codex\plugins\cache\openai-primary-runtime\documents\26.819.11345\skills\documents\render_docx.py"
$soffice = (Get-Command soffice -ErrorAction SilentlyContinue).Source
if (-not $soffice) { $soffice = (Get-Command libreoffice -ErrorAction SilentlyContinue).Source }
$pdftoppm = (Get-Command pdftoppm -ErrorAction SilentlyContinue).Source
if (-not $soffice) {
  $soffice = @(
    "C:\Program Files\LibreOffice\program\soffice.exe",
    "C:\Program Files (x86)\LibreOffice\program\soffice.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $pdftoppm) {
  $pdftoppm = @(
    "$env:LOCALAPPDATA\IITP\poppler\poppler-26.02.0\Library\bin\pdftoppm.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
$toolDirs = @($soffice, $pdftoppm) | Where-Object { $_ } | ForEach-Object { Split-Path -Parent $_ }
if ($toolDirs) { $env:Path = (($toolDirs + $env:Path.Split(';')) | Select-Object -Unique) -join ';' }

if (-not $python) { throw "Python을 찾지 못했습니다. Codex workspace Python 또는 python을 설치하세요." }
if (-not (Test-Path $Docx)) { throw "DOCX 파일을 찾지 못했습니다: $Docx" }
if (-not (Test-Path $renderDocx)) { throw "문서 스킬의 render_docx.py를 찾지 못했습니다: $renderDocx" }
if (-not $soffice) { throw "LibreOffice(soffice)가 없습니다. 설치 후 다시 실행하세요." }

& $python $renderDocx $Docx --output_dir (Join-Path $outputPath "docx") --emit_pdf
if ($LASTEXITCODE -ne 0) { throw "DOCX 렌더링에 실패했습니다." }
$docxPages = @(Get-ChildItem (Join-Path $outputPath "docx") -Filter "page-*.png")
if ($docxPages.Count -eq 0) { throw "DOCX 렌더링 PNG가 생성되지 않았습니다." }
Write-Host "DOCX pages: $($docxPages.Count)"

if ($Pdf) {
  if (-not (Test-Path $Pdf)) { throw "PDF 파일을 찾지 못했습니다: $Pdf" }
  if (-not $pdftoppm) { throw "Poppler pdftoppm이 없습니다. 설치 후 다시 실행하세요." }
  $pdfOutputPath = Join-Path $outputPath "pdf"
  New-Item -ItemType Directory -Force $pdfOutputPath | Out-Null
  & $pdftoppm -png $Pdf (Join-Path $pdfOutputPath "page")
  if ($LASTEXITCODE -ne 0) { throw "PDF 렌더링에 실패했습니다." }
  $pdfPages = @(Get-ChildItem $pdfOutputPath -Filter "page-*.png")
  if ($pdfPages.Count -eq 0) { throw "PDF 렌더링 PNG가 생성되지 않았습니다." }
  Write-Host "PDF pages: $($pdfPages.Count)"
}

Write-Host "렌더링 완료. 생성된 PNG를 100% 확대해 페이지별로 확인하세요: $outputPath"
