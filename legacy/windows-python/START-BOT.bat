@echo off
setlocal
cd /d "%~dp0"

if exist "config.json" goto config_ready
copy /y "config.example.json" "config.json" >nul
echo Fill in the three values in config.json, save it, and close Notepad.
echo The README explains where to find them. Never share your bot token.
notepad "config.json"
pause
:config_ready

if exist ".venv\Scripts\python.exe" goto run_bot

py -3 -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1
if not errorlevel 1 goto use_py
python -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1
if not errorlevel 1 goto use_python
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" goto use_codex_python
echo Python was not found. Install Python 3.10 or newer from https://www.python.org/downloads/
echo Enable "Add Python to PATH" during installation, then reopen this file.
goto finish

:use_py
py -3 -m venv .venv
goto venv_created
:use_python
python -m venv .venv
goto venv_created
:use_codex_python
"%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m venv .venv
:venv_created
if not exist ".venv\Scripts\python.exe" (
    echo Could not create the Python environment. Check the message above.
    goto finish
)

:run_bot
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo Could not install the dependency. Check your internet connection and retry.
    goto finish
)
".venv\Scripts\python.exe" bot.py
:finish
pause
