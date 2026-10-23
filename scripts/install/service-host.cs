// Fixed virtual-account service host. No general command, path or model execution API.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
public sealed class GatewayService : ServiceBase {
    private Process child;
    private bool ownerSetup;
    public GatewayService() { ServiceName="TelegramMCPGateway"; CanStop=true; AutoLog=false; }
    private static string Text(Dictionary<string,object> config,string key) {
        object value; if(!config.TryGetValue(key,out value)||!(value is string))throw new InvalidDataException();return (string)value;
    }
    private static string Quoted(string path) { if(path.IndexOf('"')>=0||path.IndexOf('\r')>=0||path.IndexOf('\n')>=0)throw new InvalidDataException();return "\""+path+"\""; }
    protected override void OnStart(string[] args) {
        try {
            ownerSetup=args.Length==2&&args[0]=="owner-setup"&&Regex.IsMatch(args[1],"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
            if(args.Length!=0&&!ownerSetup)throw new InvalidDataException();
            string common=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            string prefix=Path.Combine(common,"TelegramMCPGateway");
            string file=Path.Combine(prefix,"service.json");
            var info=new FileInfo(file);if(!info.Exists||info.Length>16384||(info.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException();
            var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
            string node=Text(config,"node"),entry=Text(config,"entry"),state=Text(config,"state"),files=Text(config,"files"),logs=Text(config,"logs");
            string release=Path.GetDirectoryName(node);string sha=Path.GetFileName(release);
            if(!Regex.IsMatch(sha,"^[0-9a-f]{40}$")||!String.Equals(release,Path.Combine(prefix,"releases",sha),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(node,Path.Combine(release,"node.exe"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(entry,Path.Combine(release,"application","dist","cli","index.js"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(state,Path.Combine(prefix,"state"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(files,Path.Combine(prefix,"files"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(logs,Path.Combine(prefix,"logs"),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException();
            int port=Convert.ToInt32(config["port"]);if(port<1||port>65535||Text(config,"toolsets")!="core")throw new InvalidDataException();
            string command=ownerSetup?Quoted(Path.Combine(release,"application","dist","setup","ownerWindows.js"))+" "+args[1]:Quoted(entry)+" serve --toolsets core --host 127.0.0.1 --port "+port+" --files-dir "+Quoted(files);
            var start=new ProcessStartInfo(node,command);
            start.UseShellExecute=false;start.CreateNoWindow=true;start.WorkingDirectory=release;
            start.EnvironmentVariables.Clear();start.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            start.EnvironmentVariables["PATH"]=Path.Combine(start.EnvironmentVariables["SystemRoot"],"System32");start.EnvironmentVariables["TG_MCP_HOME"]=state;
            start.RedirectStandardOutput=true;start.RedirectStandardError=true;
            child=new Process();child.StartInfo=start;child.EnableRaisingEvents=true;
            child.OutputDataReceived+=(sender,eventArgs)=>{if(!ownerSetup&&eventArgs.Data!=null)Append(logs,"stdout.log",eventArgs.Data);};
            child.ErrorDataReceived+=(sender,eventArgs)=>{if(!ownerSetup&&eventArgs.Data!=null)Append(logs,"stderr.log",eventArgs.Data);};
            child.Exited+=(sender,eventArgs)=>{ExitCode=ownerSetup?0:1;Stop();};
            if(!child.Start())throw new InvalidDataException();child.BeginOutputReadLine();child.BeginErrorReadLine();
        } catch { ExitCode=1;throw new InvalidOperationException("gateway_service_start_failed"); }
    }
    protected override void OnCustomCommand(int command) {
        if(command!=129||ownerSetup)return;
        try {
            string prefix=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"TelegramMCPGateway");
            string ack=Path.Combine(prefix,"owner-setup","client-ack.json");if(!File.Exists(ack))return;
            var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(prefix,"service.json")));
            string node=Text(config,"node");string release=Path.GetDirectoryName(node);string sha=Path.GetFileName(release);
            if(!Regex.IsMatch(sha,"^[0-9a-f]{40}$")||!String.Equals(release,Path.Combine(prefix,"releases",sha),StringComparison.OrdinalIgnoreCase)||!String.Equals(node,Path.Combine(release,"node.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException();
            var start=new ProcessStartInfo(node,Quoted(Path.Combine(release,"application","dist","setup","ackWindows.js")));
            start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;start.EnvironmentVariables.Clear();
            start.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            using(var receipt=Process.Start(start)){if(receipt==null)throw new InvalidDataException();receipt.OutputDataReceived+=(sender,e)=>{};receipt.ErrorDataReceived+=(sender,e)=>{};receipt.BeginOutputReadLine();receipt.BeginErrorReadLine();if(!receipt.WaitForExit(30000)){receipt.Kill();receipt.WaitForExit();}}
        } catch { /* No public/private output and no daemon disruption on a failed receipt. */ }
    }
    private static readonly object logLock=new object();
    private static void Append(string directory,string name,string line) { lock(logLock){try{File.AppendAllText(Path.Combine(directory,name),line+Environment.NewLine);}catch{}} }
    protected override void OnStop() { if(child!=null){try{if(!child.HasExited){try{child.Kill();}catch{if(!child.HasExited)throw;}}child.WaitForExit();}catch{throw new InvalidOperationException("gateway_worker_stop_failed");}child.Dispose();child=null;} }
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static void Immutable(string path) {
        FileSystemInfo item=Directory.Exists(path)?(FileSystemInfo)new DirectoryInfo(path):new FileInfo(path);
        if(!item.Exists||(item.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException();
        FileSystemSecurity acl;if(item is DirectoryInfo)acl=((DirectoryInfo)item).GetAccessControl();else acl=((FileInfo)item).GetAccessControl();
        string owner=acl.GetOwner(typeof(SecurityIdentifier)).Value;
        if(owner!="S-1-5-32-544"&&owner!="S-1-5-18")throw new InvalidDataException();
        FileSystemRights mutation=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
        if(String.Equals(path,"C:\\",StringComparison.OrdinalIgnoreCase)||String.Equals(path,"C:\\ProgramData",StringComparison.OrdinalIgnoreCase))mutation&=~(FileSystemRights.CreateFiles|FileSystemRights.CreateDirectories);
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
            string sid=rule.IdentityReference.Value;
            if(rule.AccessControlType==AccessControlType.Allow&&sid!="S-1-5-32-544"&&sid!="S-1-5-18"&&(rule.FileSystemRights&mutation)!=0)throw new InvalidDataException();
        }
    }
    private static void OwnerBroker(string id,string sha) {
        if(!Regex.IsMatch(id,"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")||!Regex.IsMatch(sha,"^[0-9a-f]{40}$")
            ||!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))throw new InvalidDataException();
        string release=Path.Combine("C:\\ProgramData\\TelegramMCPGateway\\releases",sha);
        string self=System.Reflection.Assembly.GetExecutingAssembly().Location;
        if(!String.Equals(self,Path.Combine(release,"application","dist","native","service-host.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException();
        string script=Path.Combine(release,"application","dist","setup","owner-windows.ps1");
        for(string path=script;path!=null;path=Path.GetDirectoryName(path)){Immutable(path);}
        using(var pipe=new NamedPipeClientStream(".","TelegramMCPSetup-"+id,PipeDirection.InOut,PipeOptions.Asynchronous)) {
            pipe.Connect(10000);uint pid;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid))throw new InvalidDataException();
            IntPtr process=OpenProcess(0x1000,false,pid);IntPtr token=IntPtr.Zero;
            try {
                if(process==IntPtr.Zero||!OpenProcessToken(process,8,out token))throw new InvalidDataException();
                using(var identity=new WindowsIdentity(token)){if(identity.User.Value!=WindowsIdentity.GetCurrent().User.Value)throw new InvalidDataException();}
            } finally {if(token!=IntPtr.Zero)CloseHandle(token);if(process!=IntPtr.Zero)CloseHandle(process);}
            string powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
            var start=new ProcessStartInfo(powershell,"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Quoted(script)+" -SourceSha "+sha+" -BrokerStdio");
            start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
            start.EnvironmentVariables.Clear();start.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            using(var worker=Process.Start(start)) {
                if(worker==null)throw new InvalidDataException();worker.ErrorDataReceived+=(sender,e)=>{};worker.BeginErrorReadLine();
                Task.Run(()=>{try{pipe.CopyTo(worker.StandardInput.BaseStream);}catch{}finally{try{worker.StandardInput.Close();}catch{}}});
                try {worker.StandardOutput.BaseStream.CopyTo(pipe);worker.WaitForExit();Environment.ExitCode=worker.ExitCode;}
                finally {try{worker.StandardInput.Close();}catch{}if(!worker.HasExited){if(!worker.WaitForExit(30000)){worker.Kill();worker.WaitForExit();}}}
            }
        }
    }
    public static void Main(string[] args) {
        if(args.Length==0){ServiceBase.Run(new GatewayService());return;}
        try {if(args.Length!=3||args[0]!="owner-broker")throw new InvalidDataException();OwnerBroker(args[1],args[2]);}
        catch {Environment.ExitCode=1;}
    }
}

// Console.In.ReadAsync is synchronous on .NET Framework's SyncTextReader.
// One bounded background reader keeps coordinator deadlines/service-exit checks live.
public sealed class OwnerInputReader : IDisposable {
    private readonly System.Collections.Concurrent.BlockingCollection<string> lines=new System.Collections.Concurrent.BlockingCollection<string>(1);
    private volatile bool failed;
    private volatile bool stopping;
    public bool Failed { get { return failed&&lines.Count==0; } }
    public OwnerInputReader() {
        var thread=new System.Threading.Thread(Read);thread.IsBackground=true;thread.Start();
    }
    private void Read() {
        try {
            var input=Console.OpenStandardInput();var bytes=new MemoryStream();var encoding=new System.Text.UTF8Encoding(false,true);
            while(!stopping) {
                int value=input.ReadByte();if(value<0){failed=true;return;}
                if(value==10) {
                    string line=encoding.GetString(bytes.ToArray());bytes.SetLength(0);
                    if(!lines.TryAdd(line,5000)){failed=true;return;}
                } else {if(bytes.Length>=2048){failed=true;return;}bytes.WriteByte((byte)value);}
            }
        } catch { failed=true; }
    }
    public string TryRead(int milliseconds) { string line;return lines.TryTake(out line,milliseconds)?line:null; }
    public void Dispose() { stopping=true; }
}
