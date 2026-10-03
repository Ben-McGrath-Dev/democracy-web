@echo off
echo Preparing to force sync local files to GitHub...

:: 1. Force stage all local folder changes
git add -A

:: 2. Prompt the user for a custom commit message
echo.
set /p commit_msg="Enter a name for this commit: "

:: If the user presses enter without typing anything, give it a default name
if "%commit_msg%"=="" set commit_msg="Manual local update - Overwriting remote"

:: 3. Create the local commit save point
git commit -m "%commit_msg%"

:: 4. Force push to main, completely overwriting the GitHub repository state
echo.
echo Overwriting GitHub repository with local folder contents...
git push origin main --force

echo.
echo Sync complete! Your local folder has overwritten GitHub.
pause