/** Native profile IO only; Windows uses the pinned local broker, not path writes. */
export const HERMES_PROFILE_FILES=String.raw`
def profile_fs_ready():
    if os.name == 'nt':
        if len(sys.argv) != 3 or not os.path.isabs(sys.argv[2]): fail('employee_profile_platform_unsupported')
        value=_profile_broker('probe')
        if value.get('version')!=2 or value.get('platform')!='win32': fail('employee_profile_platform_unsupported')
    elif not hasattr(os,'O_NOFOLLOW') or os.open not in os.supports_dir_fd:
        fail('employee_profile_platform_unsupported')

def profile_root(path, expected=None):
    if os.name != 'nt': return os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    value=_profile_broker('root',root=str(path))
    if value['kind']!='directory' or expected is not None and value['identity']!=expected: fail('employee_profile_identity_changed')
    return _ProfileDirectory(str(path),value['identity'])

def profile_close(fd):
    if os.name != 'nt': os.close(fd)

def profile_dup(fd):
    return _ProfileDirectory(fd.path,fd.identity) if os.name=='nt' else os.dup(fd)

def profile_identity(fd):
    if os.name=='nt': return fd.identity
    value=os.fstat(fd)
    return 'p:'+format(value.st_dev,'x')+':'+format(value.st_ino,'x')

def profile_entries(fd):
    if os.name != 'nt': return os.listdir(fd)
    profile_root(fd.path,fd.identity)
    names=os.listdir(fd.path)
    profile_root(fd.path,fd.identity)
    return names

def profile_sync(fd):
    if os.name != 'nt': os.fsync(fd)
    else: profile_root(fd.path,fd.identity)

def profile_publish(parent,stage,name,opened):
    if os.name != 'nt':
        os.rename(stage,name,src_dir_fd=parent,dst_dir_fd=parent)
    else:
        value=_profile_broker('publish_new',parent,stage,destination=name)
        if value['identity']!=opened.identity: fail('employee_profile_identity_changed')

def profile_private_directory(fd):
    if os.name == 'nt':
        _profile_windows_owner(fd.path,fd.identity)
    else:
        value=os.fstat(fd)
        if value.st_uid!=os.getuid() or value.st_mode&0o022: fail('employee_profile_owner_conflict')

def profile_private_marker(fd,name):
    if os.name == 'nt':
        value=_profile_broker('stat',fd,name)
        if value['kind']!='file' or int(value['sizeBytes'])>256: fail('employee_profile_owner_conflict')
        _profile_windows_owner(str(Path(fd.path)/name),value['identity'])
    else:
        value=os.stat(name,dir_fd=fd,follow_symlinks=False)
        if value.st_uid!=os.getuid() or value.st_mode&0o022 or value.st_size>256: fail('employee_profile_owner_conflict')

class _ProfileDirectory:
    def __init__(self,path,identity): self.path=path;self.identity=identity

def _profile_broker(operation,parent=None,name='',data=b'',root=None,destination=None,overwrite=True,read_limit=1048577):
    import struct,subprocess,re
    operations={'probe':0,'read':1,'write':2,'mkdir':3,'publish_new':4,'stat':5,'root':6}
    def field(text,limit):
        raw=text.encode('utf8')
        if len(raw)>limit or '\x00' in text: fail('employee_file_unsafe')
        return struct.pack('<I',len(raw))+raw
    def absent(): raise FileNotFoundError(name)
    anchored=operation not in {'probe','root'}
    flags=1 if operation=='write' and overwrite else 0
    prefix=field(parent.path if anchored else root or '',4096)+field(name,2048)
    if anchored:
        if not re.fullmatch(r'w:[a-f0-9]+:[a-f0-9]+',parent.identity): fail('employee_profile_identity_changed')
        flags|=4;prefix+=field(parent.identity,80)
    argument=read_limit if operation=='read' else len(data) if operation=='write' else len(destination.encode('utf8')) if operation=='publish_new' else 0
    tail=data if operation=='write' else destination.encode('utf8') if operation=='publish_new' else b''
    wire=b'PFS2'+bytes([operations[operation],flags,0,0])+prefix+struct.pack('<I',argument)+tail
    result=subprocess.run([sys.argv[2]],input=wire,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        timeout=10,cwd=os.path.dirname(sys.argv[2]),env={'SystemRoot':os.environ.get('SystemRoot','C:\\Windows')})
    if len(result.stdout)>1048577+4096 or len(result.stderr)>8192: fail('employee_profile_native_failure')
    line,separator,body=result.stdout.partition(b'\n')
    if not separator or len(line)>2048: fail('employee_profile_native_failure')
    reply=json.loads(line)
    if reply.get('ok') is not True:
        if result.returncode==0 or body or reply.get('mutated') is not False: fail('employee_profile_native_failure')
        if reply.get('code')=='not_found': absent()
        fail('employee_file_unsafe' if reply.get('code') in {'path_denied','path_changed'} else 'employee_profile_native_failure')
    if result.returncode!=0 or result.stderr: fail('employee_profile_native_failure')
    if operation=='probe':
        if body: fail('employee_profile_native_failure')
        return reply
    if anchored and reply.get('rootIdentity')!=parent.identity: fail('employee_profile_identity_changed')
    if not re.fullmatch(r'w:[a-f0-9]+:[a-f0-9]+',str(reply.get('identity',''))): fail('employee_profile_native_failure')
    if type(reply.get('dataBytes')) is not int or reply['dataBytes']!=len(body) or type(reply.get('truncated')) is not bool or type(reply.get('mutated')) is not bool:
        fail('employee_profile_native_failure')
    if operation!='read' and body: fail('employee_profile_native_failure')
    reply['data']=body
    return reply

def profile_windows_read_guard(parent,name):
    import ctypes
    from ctypes import wintypes as w
    value=_profile_broker('read',parent,name,read_limit=1)
    if value['kind']!='file': fail('employee_file_unsafe')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE];kernel.CreateFileW.restype=w.HANDLE
    kernel.CloseHandle.argtypes=[w.HANDLE]
    kernel.GetFileInformationByHandleEx.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    class FileID(ctypes.Structure): _fields_=[('volume',ctypes.c_ulonglong),('file',ctypes.c_ubyte*16)]
    class Standard(ctypes.Structure): _fields_=[('allocation',ctypes.c_longlong),('end',ctypes.c_longlong),('links',w.DWORD),('pending',w.BYTE),('directory',w.BYTE)]
    class Attributes(ctypes.Structure): _fields_=[('attributes',w.DWORD),('tag',w.DWORD)]
    handles=[]
    def opened(path,expected,directory):
        handle=kernel.CreateFileW(path,0x1|0x80|0x100000,3,None,3,0x02000000|0x00200000,None)
        if handle in {None,0,ctypes.c_void_p(-1).value}: fail('employee_file_unsafe')
        handles.append(handle);identity=FileID();standard=Standard();attributes=Attributes()
        if not kernel.GetFileInformationByHandleEx(handle,18,ctypes.byref(identity),ctypes.sizeof(identity)) or not kernel.GetFileInformationByHandleEx(handle,1,ctypes.byref(standard),ctypes.sizeof(standard)) or not kernel.GetFileInformationByHandleEx(handle,9,ctypes.byref(attributes),ctypes.sizeof(attributes)):
            fail('employee_file_unsafe')
        actual='w:'+format(identity.volume,'x')+':'+bytes(identity.file).hex()
        if actual!=expected or bool(standard.directory)!=directory or attributes.attributes&0x400 or not directory and standard.links!=1:
            fail('employee_profile_identity_changed')
    try:
        opened(parent.path,parent.identity,True);opened(str(Path(parent.path)/name),value['identity'],False)
        return {'handles':handles,'identity':value['identity']}
    except Exception:
        for handle in reversed(handles): kernel.CloseHandle(handle)
        raise

def profile_windows_close_guard(guard):
    import ctypes
    from ctypes import wintypes as w
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.CloseHandle.argtypes=[w.HANDLE]
    for handle in reversed(guard['handles']): kernel.CloseHandle(handle)

def _profile_windows_owner(path,expected):
    # Query the same volume/file ID as the no-follow broker before trusting ACLs.
    import ctypes,struct
    from ctypes import wintypes as w
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);security=ctypes.WinDLL('advapi32',use_last_error=True)
    kernel.GetCurrentProcess.restype=w.HANDLE
    kernel.CloseHandle.argtypes=[w.HANDLE]
    kernel.LocalFree.argtypes=[ctypes.c_void_p]
    kernel.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE];kernel.CreateFileW.restype=w.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    security.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,ctypes.POINTER(w.HANDLE)]
    security.GetTokenInformation.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD,ctypes.POINTER(w.DWORD)]
    security.ConvertSidToStringSidW.argtypes=[ctypes.c_void_p,ctypes.POINTER(w.LPWSTR)]
    security.IsValidSid.argtypes=[ctypes.c_void_p]
    security.GetSecurityInfo.argtypes=[w.HANDLE,ctypes.c_int,w.DWORD,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p)]
    security.GetSecurityInfo.restype=w.DWORD
    security.GetAce.argtypes=[ctypes.c_void_p,w.DWORD,ctypes.POINTER(ctypes.c_void_p)]
    def sid(value):
        if not value or not security.IsValidSid(value): fail('employee_profile_owner_conflict')
        text=w.LPWSTR()
        if not security.ConvertSidToStringSidW(value,ctypes.byref(text)): fail('employee_profile_owner_conflict')
        try: return text.value
        finally: kernel.LocalFree(ctypes.cast(text,ctypes.c_void_p))
    token=w.HANDLE()
    if not security.OpenProcessToken(kernel.GetCurrentProcess(),8,ctypes.byref(token)): fail('employee_profile_owner_conflict')
    def token_sid(kind):
        size=w.DWORD();security.GetTokenInformation(token,kind,None,0,ctypes.byref(size))
        if size.value<ctypes.sizeof(ctypes.c_void_p) or size.value>65536: fail('employee_profile_owner_conflict')
        buffer=ctypes.create_string_buffer(size.value)
        if not security.GetTokenInformation(token,kind,buffer,size.value,ctypes.byref(size)): fail('employee_profile_owner_conflict')
        return sid(ctypes.cast(buffer,ctypes.POINTER(ctypes.c_void_p))[0])
    try: user=token_sid(1);owner_identity=token_sid(4)
    finally: kernel.CloseHandle(token)
    handle=kernel.CreateFileW(path,0x20000|0x80|0x100000,3,None,3,0x02000000|0x00200000,None)
    if handle in {None,0,ctypes.c_void_p(-1).value}: fail('employee_profile_owner_conflict')
    descriptor=ctypes.c_void_p()
    try:
        class FileID(ctypes.Structure): _fields_=[('volume',ctypes.c_ulonglong),('file',ctypes.c_ubyte*16)]
        identity=FileID()
        if not kernel.GetFileInformationByHandleEx(handle,18,ctypes.byref(identity),ctypes.sizeof(identity)): fail('employee_profile_owner_conflict')
        actual='w:'+format(identity.volume,'x')+':'+bytes(identity.file).hex()
        if actual!=expected: fail('employee_profile_identity_changed')
        owner=ctypes.c_void_p();acl=ctypes.c_void_p()
        if security.GetSecurityInfo(handle,1,1|4,ctypes.byref(owner),None,ctypes.byref(acl),None,ctypes.byref(descriptor))!=0 or not acl.value:
            fail('employee_profile_owner_conflict')
        if sid(owner.value) not in {user,owner_identity}: fail('employee_profile_owner_conflict')
        header=ctypes.string_at(acl.value,8);length,count=struct.unpack_from('<HH',header,2)
        if length<8: fail('employee_profile_owner_conflict')
        trusted={user,owner_identity,'S-1-5-18','S-1-5-32-544'}
        writable=0x2|0x4|0x10|0x40|0x100|0x10000|0x40000|0x80000|0x10000000|0x40000000
        for index in range(count):
            ace=ctypes.c_void_p()
            if not security.GetAce(acl,index,ctypes.byref(ace)) or not ace.value or ace.value<acl.value+8: fail('employee_profile_owner_conflict')
            data=ctypes.string_at(ace.value,4);kind=data[0];size=struct.unpack_from('<H',data,2)[0]
            if size<4 or ace.value+size>acl.value+length: fail('employee_profile_owner_conflict')
            if kind==1: continue
            if kind!=0 or size<12: fail('employee_profile_owner_conflict')
            mask=struct.unpack('<I',ctypes.string_at(ace.value+4,4))[0]
            if mask&writable and sid(ace.value+8) not in trusted: fail('employee_profile_owner_conflict')
    finally:
        if descriptor.value: kernel.LocalFree(descriptor)
        kernel.CloseHandle(handle)

def _profile_windows_replace(parent,temp,name,expected):
    import ctypes
    from ctypes import wintypes as w
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);nt=ctypes.WinDLL('ntdll')
    kernel.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE];kernel.CreateFileW.restype=w.HANDLE
    kernel.CloseHandle.argtypes=[w.HANDLE]
    kernel.GetFileInformationByHandleEx.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    kernel.SetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    class FileID(ctypes.Structure): _fields_=[('volume',ctypes.c_ulonglong),('file',ctypes.c_ubyte*16)]
    class Standard(ctypes.Structure): _fields_=[('allocation',ctypes.c_longlong),('end',ctypes.c_longlong),('links',w.DWORD),('pending',w.BYTE),('directory',w.BYTE)]
    class Attributes(ctypes.Structure): _fields_=[('attributes',w.DWORD),('tag',w.DWORD)]
    class Status(ctypes.Structure): _fields_=[('status',ctypes.c_void_p),('information',ctypes.c_size_t)]
    nt.NtSetInformationFile.argtypes=[w.HANDLE,ctypes.POINTER(Status),ctypes.c_void_p,w.DWORD,ctypes.c_int];nt.NtSetInformationFile.restype=ctypes.c_long
    def opened(path,access,share):
        handle=kernel.CreateFileW(path,access|0x80|0x100000,share,None,3,0x02000000|0x00200000,None)
        if handle in {None,0,ctypes.c_void_p(-1).value}: fail('employee_file_unsafe')
        return handle
    def verify(handle,wanted,directory):
        identity=FileID();standard=Standard();attributes=Attributes()
        if not kernel.GetFileInformationByHandleEx(handle,18,ctypes.byref(identity),ctypes.sizeof(identity)) or not kernel.GetFileInformationByHandleEx(handle,1,ctypes.byref(standard),ctypes.sizeof(standard)) or not kernel.GetFileInformationByHandleEx(handle,9,ctypes.byref(attributes),ctypes.sizeof(attributes)):
            fail('employee_file_unsafe')
        if 'w:'+format(identity.volume,'x')+':'+bytes(identity.file).hex()!=wanted or bool(standard.directory)!=directory or attributes.attributes&0x400 or not directory and standard.links!=1:
            fail('employee_profile_identity_changed')
    if name in {'.','..'} or any(c in name for c in ['\\','/',':','\x00']): fail('employee_file_unsafe')
    directory=opened(parent.path,0x1|0x2|0x20,3);source=None;published=False;validated=False
    try:
        verify(directory,parent.identity,True)
        source=opened(str(Path(parent.path)/temp),0x10000,1);verify(source,expected,False);validated=True
        encoded=name.encode('utf-16-le')
        class Rename(ctypes.Structure): _fields_=[('replace',w.BYTE),('root',w.HANDLE),('length',w.DWORD),('name',ctypes.c_ubyte*(len(encoded)+2))]
        value=Rename();value.replace=1;value.root=directory;value.length=len(encoded)
        ctypes.memmove(ctypes.addressof(value)+Rename.name.offset,encoded,len(encoded));status=Status()
        if nt.NtSetInformationFile(source,ctypes.byref(status),ctypes.byref(value),Rename.name.offset+len(encoded),10)<0: fail('employee_profile_native_failure')
        published=True;verify(directory,parent.identity,True);verify(source,expected,False)
    finally:
        if source is not None:
            if not published and validated:
                delete=w.BOOL(True);kernel.SetFileInformationByHandle(source,4,ctypes.byref(delete),ctypes.sizeof(delete))
            kernel.CloseHandle(source)
        kernel.CloseHandle(directory)

if os.name == 'nt':
    def directory(parent,name,create=False):
        value=_profile_broker('mkdir' if create else 'stat',parent,name)
        if value['kind']!='directory': fail('employee_file_unsafe')
        return _ProfileDirectory(str(Path(parent.path)/name),value['identity'])
    def read(parent,name,optional=False,too_large='employee_file_unsafe'):
        try: value=_profile_broker('read',parent,name)
        except FileNotFoundError:
            if optional: return None
            raise
        if value['kind']!='file': fail('employee_file_unsafe')
        if value['truncated'] or len(value['data'])>1048576 or int(value['sizeBytes'])>1048576: fail(too_large)
        return value['data']
    def write(parent,name,data):
        if len(data)>1048576: fail('employee_file_unsafe')
        temp='.phonon-write-'+uuid.uuid4().hex
        value=_profile_broker('write',parent,temp,data=data,overwrite=False)
        if value['kind']!='file' or int(value['sizeBytes'])!=len(data): fail('employee_profile_native_failure')
        _profile_windows_replace(parent,temp,name,value['identity'])
`;
