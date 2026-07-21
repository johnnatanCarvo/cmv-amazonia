@echo off
setlocal
cd /d "%~dp0"

set LOCK=.autoupdate.lock
echo locked > "%LOCK%"

echo [%date% %time%] Iniciando atualizacao automatica >> update.log

call npx clasp push --force >> update.log 2>&1

git add -A
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "auto: atualizacao %date% %time%" >> update.log 2>&1
    git push origin dev >> update.log 2>&1

    git checkout main >> update.log 2>&1
    git merge dev --no-edit >> update.log 2>&1
    git push origin main >> update.log 2>&1
    git checkout dev >> update.log 2>&1
) else (
    echo [%date% %time%] Sem mudancas para commitar >> update.log
)

echo [%date% %time%] Atualizacao concluida >> update.log
del "%LOCK%"
endlocal
