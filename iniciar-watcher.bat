@echo off
cd /d "%~dp0"
echo Iniciando watcher de atualizacao automatica...
echo Deixe esta janela aberta enquanto estiver editando o projeto.
echo Para parar, so fechar esta janela.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "watch.ps1"
