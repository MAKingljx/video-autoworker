on run
  try
    set launcherPath to POSIX path of (path to resource "start-aiworker-runtime.sh")
  on error
    display dialog "启动器内置脚本不可用，请重新生成桌面 App。" buttons {"好"} default button "好" with icon stop
    return
  end try

  display notification "正在检查并按需启动千问、OpenClaw 与可视化平台。" with title "AI-worker 一键启动"

  try
    with timeout of 360 seconds
      set resultText to do shell script "/bin/bash " & quoted form of launcherPath & " 2>&1"
    end timeout
  on error errorMessage number errorNumber
    display dialog "AI-worker 启动未完成。" & return & return & errorMessage buttons {"好"} default button "好" with icon caution
    return
  end try

  set selectedButton to button returned of (display dialog resultText buttons {"完成", "打开控制台"} default button "打开控制台" with title "AI-worker 一键启动" with icon note)
  if selectedButton is "打开控制台" then
    do shell script "/usr/bin/open http://127.0.0.1:3017/profiles"
  end if
end run
