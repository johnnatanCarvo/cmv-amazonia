@echo off
setlocal
cd /d "%~dp0"

set LOCK=.autoupdate.lock
set DEPLOY_ID=AKfycbzwf1mhkYAKpBCJcli2Ou_-9dQ-k1_w76qKIuBobH8mUqOAN1KQD6k7Yhu_axa4uaMtyQ
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

    rem clasp push so atualiza o HEAD do projeto — a URL publicada (/exec)
    rem fica presa numa versao ate isso criar uma nova versao pra ela.
    echo [%date% %time%] Atualizando implantacao publicada (%DEPLOY_ID%) >> update.log
    call npx clasp deploy --deploymentId %DEPLOY_ID% --description "auto: %date% %time%" >> update.log 2>&1
) else (
    echo [%date% %time%] Sem mudancas para commitar >> update.log
)

echo [%date% %time%] Atualizacao concluida >> update.log
del "%LOCK%"
endlocal
