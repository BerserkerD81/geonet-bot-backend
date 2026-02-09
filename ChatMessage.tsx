import { useEffect, useState, useMemo } from 'react';
import { 
  Bot, Check, Check as CheckIcon, ChevronLeft, ChevronRight, ChevronsUpDown, 
  Copy, RotateCcw, MapPin, Maximize2, Download, Eye, EyeOff, X, ImageOff, Loader2,
  Server, HardDrive, Network, Lock, Settings2, CheckCircle2, Circle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useAuth } from '../contexts/AuthContext';

// --- CONSTANTES DE CONFIGURACIÓN DEL FORMULARIO ---
const HIDDEN_FIELDS = ['auth-olt_id', 'auth-pon_type', 'auth-board', 'auth-onu_mode', 'auth-port'];
const READ_ONLY_FIELDS = ['auth-name', 'auth-sn'];
const AUTO_SELECT_FIELDS = ['auth-onu_type', 'auth-vlan', 'auth-zone'];

// --- TIPOS ---

// Tipo explícito para los pasos del proceso
type ProcessStep = {
  id: string;
  label: string;
  status: 'pending' | 'loading' | 'complete' | 'error';
};

type OnuEntry = {
  id: string;
  label: string;
  ponType?: string;
  port?: string;
  board?: string;
  ponPort?: string;
  sn?: string;
  type?: string;
  model?: string;
  description?: string;
  actionPayload?: string;
};

type OltEntry = {
  oltId: string;
  oltName?: string;
  availableCount?: number;
  onus: OnuEntry[];
};

type OdbApiResponseItem = {
  id?: string | number;
  name?: string;
  externalId?: string | number;
};

type PortApiResponseItem = string | number | { port: string | number };

type ActionOption = {
  id: string;
  label: string;
  type: 'button' | 'input' | 'link';
  placeholder?: string;
  options?: string[];
  payload?: string;
  helperText?: string;
  url?: string;
  value?: string;
  disabled?: boolean;
};

type SmartoltAvailability = {
  olts?: OltEntry[];
  suggestedVlan?: string;
  suggestedZone?: string;
};

type InstallationEntry = {
  id: string;
  clientName: string;
  rut?: string;
  address?: string;
  actionPayload?: string;
};

type MessageMetadata = {
  smartoltAvailability?: SmartoltAvailability;
  installations?: InstallationEntry[];
};

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  imageDataUrl?: string;
  createdAt?: string;
  isLatest?: boolean;
  isAwaitingResponse?: boolean;
  onRetry?: () => void;
  shouldAnimate?: boolean;
  messageId?: string;
  versions?: string[];
  currentVersion?: number;
  onVersionChange?: (messageId: string, direction: 'prev' | 'next') => void;
  actions?: ActionOption[];
  onActionSelect?: (payload: string) => void;
  onSubmitAuth?: (collected: Record<string, string>) => void | Promise<void>;
  onSubmitWan?: (collected: Record<string, string>) => void | Promise<void>;
  onSubmitAction?: (payload: string, collected: Record<string, string>) => void | Promise<void>;
  highlighted?: boolean;
  metadata?: MessageMetadata | null;
}

// --- UTILIDADES ---

const API_BASE = (() => {
  const envApi = (import.meta.env as Record<string, string | undefined>).VITE_API_URL;
  
  if (envApi && envApi.trim()) {
    // CORRECCIÓN: Si es ruta relativa (empieza con /) o ya tiene http, la dejamos tal cual.
    if (envApi.startsWith('/') || envApi.startsWith('http')) {
      return envApi;
    }
    // Solo agregamos protocolo si es un dominio a secas (ej: localhost:3000)
    return `http://${envApi}`;
  }
  
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:3000`;
})();

const resolveImageUrl = (url?: string) => {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  const cleanBase = API_BASE.replace(/\/+$/, '');
  const cleanPath = url.replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
};

const normalizeSpeedProfile = (val: string) => {
  const raw = (val || '').trim();
  if (!raw) return '';
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return raw;
  const num = match[1].replace(/\.0+$/, '');
  return `${num}M`;
};

const parseMarkdownTableToInstallations = (content: string, actions?: ActionOption[], preferClientSelect: boolean = false): InstallationEntry[] => {
  try {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
    if (lines.length < 3) return [];

    const header = lines[0].toLowerCase();
    if (!header.includes('cliente') || !header.includes('dirección')) return [];

    const dataLines = lines.slice(2);
    const parsed: InstallationEntry[] = [];

    dataLines.forEach(line => {
      const cols = line.split('|').map(c => c.trim());
      if (cols.length >= 6) {
        const clientName = cols[2];
        const rut = cols[3];
        const installId = cols[4];
        const address = cols[5];
        if (!installId || !clientName || installId === '-') return;

        const relatedAction = actions?.find(
          a => a.id === `select-installation-${installId}` || 
               (a.payload && a.payload.includes(`instalación ${installId}`))
        );

        const actionPayload = preferClientSelect
          ? `seleccionar cliente ${installId}`
          : (relatedAction?.payload || `seleccionar instalación ${installId}`);

        parsed.push({
          id: installId,
          clientName,
          rut,
          address,
          actionPayload
        });
      }
    });
    return parsed;
  } catch (e) {
    console.error("Error parseando tabla markdown", e);
    return [];
  }
};

// --- COMPONENTE: MODAL DE PROCESAMIENTO ---
// Corrección: Usamos ProcessStep[] en lugar de any[]
function ProcessingModal({ isOpen, steps }: { isOpen: boolean; steps: ProcessStep[] }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md px-4"
        >
          <motion.div
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-neutral-900 border border-neutral-800 p-8 rounded-3xl shadow-2xl max-w-sm w-full"
          >
            <div className="flex flex-col items-center text-center mb-8">
              <div className="h-16 w-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4 text-emerald-500">
                <Settings2 className="animate-spin size-8" />
              </div>
              <h3 className="text-xl font-bold text-white">Configurando Acceso</h3>
              <p className="text-neutral-500 text-sm mt-1">Sincronizando con SmartOLT y Geonet</p>
            </div>

            <div className="space-y-5">
              {steps.map((step) => (
                <motion.div 
                  key={step.id} 
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-4"
                >
                  {step.status === 'loading' ? (
                    <Loader2 className="size-5 text-emerald-500 animate-spin" />
                  ) : step.status === 'complete' ? (
                    <CheckCircle2 className="size-5 text-emerald-500" />
                  ) : (
                    <Circle className="size-5 text-neutral-700" />
                  )}
                  <span className={`text-sm font-medium transition-colors ${
                    step.status === 'loading' ? 'text-white' : 
                    step.status === 'complete' ? 'text-neutral-400' : 'text-neutral-600'
                  }`}>
                    {step.label}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// --- COMPONENTES AUXILIARES ---
function SearchableSelect({
  action,
  value,
  onChange,
  disabled
}: {
  action: ActionOption;
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const display = value || 'Selecciona una opción';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          aria-expanded={open}
          className={`w-full justify-between h-10 bg-neutral-900 border-neutral-800 text-neutral-50 text-sm transition-all
            ${open ? 'border-emerald-500/50 ring-2 ring-emerald-500/20' : 'hover:border-neutral-600'} 
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span className="truncate text-left flex-1 font-medium">{display}</span>
          {!disabled && <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-100 text-neutral-400" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 bg-neutral-900 border-neutral-700 shadow-xl"
        align="start"
      >
        <Command className="bg-transparent">
          {/* CAMBIO AQUÍ: 
            [&_svg]:text-white -> Pone el icono en blanco puro.
            [&_svg]:opacity-100 -> Asegura que no tenga transparencia heredada.
          */}
          <CommandInput 
            placeholder={action.placeholder || 'Buscar...'} 
            className="text-sm text-neutral-50 placeholder:text-neutral-500 [&_svg]:text-white [&_svg]:opacity-100" 
          />
          <CommandList className="border-t border-neutral-800">
            <CommandEmpty className="py-3 text-sm text-neutral-500 text-center">Sin resultados</CommandEmpty>
            <CommandGroup>
              {action.options?.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={(val) => {
                    onChange(val);
                    setOpen(false);
                  }}
                  className="text-sm py-2.5 text-neutral-100 aria-selected:bg-neutral-800 aria-selected:text-white cursor-pointer"
                >
                  <CheckIcon className={`mr-2 h-4 w-4 text-emerald-400 ${value === opt ? 'opacity-100' : 'opacity-0'}`} />
                  <span className="truncate">{opt}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
function ImagePreview({ 
  src, 
  alt, 
  className, 
  onClick, 
  onDownload 
}: { 
  src: string; 
  alt: string; 
  className?: string; 
  onClick?: () => void;
  onDownload?: () => void;
}) {
  const [status, setStatus] = useState<'loading' | 'error' | 'success'>('loading');
  const finalSrc = resolveImageUrl(src);

  if (!finalSrc) return null;

  return (
    <div className={`relative overflow-hidden bg-neutral-950 ${className}`}>
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/50 z-10">
          <Loader2 className="h-6 w-6 text-emerald-500 animate-spin" />
        </div>
      )}
      
      {status === 'error' && (
        <div className="flex flex-col items-center justify-center w-full h-full min-h-[150px] bg-neutral-900 text-neutral-500 gap-2 p-4 border border-neutral-800 rounded-lg">
          <ImageOff className="h-8 w-8 opacity-50" />
          <span className="text-xs text-center">No se pudo cargar la imagen</span>
        </div>
      )}

      <img 
        src={finalSrc} 
        alt={alt}
        className={`w-full h-full object-cover transition-opacity duration-300 ${status === 'success' ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setStatus('success')}
        onError={() => setStatus('error')}
        onClick={status === 'success' ? onClick : undefined}
      />

      {status === 'success' && (
        <>
           <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-3 cursor-pointer" onClick={onClick}>
             <Button size="icon" variant="secondary" className="rounded-full bg-white/10 backdrop-blur-md border-white/20 hover:bg-white/20">
               <Maximize2 className="size-4 text-white" />
             </Button>
             {onDownload && (
               <Button 
                 size="icon" 
                 variant="secondary" 
                 className="rounded-full bg-white/10 backdrop-blur-md border-white/20 hover:bg-white/20"
                 onClick={(e) => { e.stopPropagation(); onDownload(); }}
               >
                 <Download className="size-4 text-white" />
               </Button>
             )}
           </div>
        </>
      )}
    </div>
  );
}

// --- COMPONENTE PRINCIPAL ---
export function ChatMessage({
  role,
  content,
  imageDataUrl,
  createdAt,
  isLatest = false,
  isAwaitingResponse = false,
  onRetry,
  shouldAnimate = false,
  messageId = '',
  versions,
  currentVersion,
  onVersionChange,
  actions,
  onActionSelect,
  onSubmitAuth,
  onSubmitWan,
  onSubmitAction,
  highlighted = false,
  metadata,
}: ChatMessageProps) {
  const { user } = useAuth();
  const authUser = user as { username?: string | null; displayName?: string | null; email?: string | null } | null;
  const isUser = role === 'user';

  // Estados
  const [copied, setCopied] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, string[]>>({});
  const [odbNameToExternalId, setOdbNameToExternalId] = useState<Record<string, string>>({});
  const [isZoomed, setIsZoomed] = useState(false);
  const [selectedOnu, setSelectedOnu] = useState<{
    oltId?: string;
    board?: string;
    port?: string;
    ponType?: string;
    onuId?: string;
  } | null>(null);
  const [wifiError, setWifiError] = useState<string | null>(null);
  const [showWifiPass, setShowWifiPass] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Estado para la animación
  const [displayedContent, setDisplayedContent] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const disableActionButtons = !isUser && isLatest && (isAwaitingResponse || isSubmitting);

  // Estados de Procesamiento (Modal) - Corrección: Tipado explícito
  const [isProcessing, setIsProcessing] = useState(false);
  const [processSteps, setProcessSteps] = useState<ProcessStep[]>([
    { id: 'auth', label: 'Validando en SmartOLT', status: 'pending' },
    { id: 'wan', label: 'Provisionando servicio WAN', status: 'pending' },
    { id: 'geonet', label: 'Registrando en Geonet/WispHub', status: 'pending' }
  ]);

  // --- LÓGICA DE INICIALIZACIÓN Y AUTO-FILL ---
  
  useEffect(() => {
    if (!actions || !Array.isArray(actions)) return;

    const initialValues: Record<string, string> = {};

    actions.forEach(action => {
      // 1. Inicializar campos ocultos y de solo lectura
      if (
        (HIDDEN_FIELDS.includes(action.id) || READ_ONLY_FIELDS.includes(action.id)) && 
        action.placeholder
      ) {
        initialValues[action.id] = action.placeholder;
      }

      // 2. Lógica de auto-selección
      if (AUTO_SELECT_FIELDS.includes(action.id) && action.options?.length && action.placeholder) {
        const placeholderVal = action.placeholder.trim();
        
        let match = action.options.find(opt => opt === placeholderVal);
        
        if (!match) {
          match = action.options.find(opt => 
            opt.startsWith(placeholderVal + ' ') || 
            opt.startsWith(placeholderVal + '-')
          );
        }

        if (match) {
          initialValues[action.id] = match;
          
          if (action.id === 'auth-zone') {
             setTimeout(() => fetchOdbOptionsForZone(match!), 100);
          }
        }
      }
    });

    setInputValues(prev => {
      const next = { ...prev };
      let changed = false;
      Object.entries(initialValues).forEach(([k, v]) => {
        if (!next[k] && v) {
          next[k] = v;
          changed = true;
        }
      });
      return changed ? next : prev;
    });

  }, [actions]);

  // --- LÓGICA DE PROCESAMIENTO DE DATOS ---

  const smartoltAvailability = (metadata?.smartoltAvailability as SmartoltAvailability | undefined) || null;
  const hasSmartoltTable = Boolean(smartoltAvailability?.olts?.length);
  
  const hasClientSelectActions = useMemo(() => {
    return (actions || []).some(a => (a?.payload || '').toLowerCase().includes('seleccionar cliente'));
  }, [actions]);

  const installations: InstallationEntry[] = useMemo(() => {
    if (metadata?.installations && metadata.installations.length > 0) return metadata.installations;
    if (!isUser && content.includes('|') && content.toLowerCase().includes('cliente')) {
      return parseMarkdownTableToInstallations(content, actions, hasClientSelectActions);
    }
    return [];
  }, [metadata, content, isUser, actions, hasClientSelectActions]);
  
  const hasInstallationsTable = Boolean(installations.length);

  // --- LÓGICA DE ANIMACIÓN ---
  
  const finalCleanText = useMemo(() => {
    if (isUser) return content;
    
    if (hasInstallationsTable || hasSmartoltTable) {
        const tableRegex = /^\|.*\|[\s\S]*?(\n(?![ \t]*\|)|$)/gm;
        const cleaned = content.replace(tableRegex, '').trim();
        return cleaned || (hasInstallationsTable ? "He encontrado las siguientes instalaciones:" : "");
    }
    
    return content;
  }, [content, isUser, hasInstallationsTable, hasSmartoltTable]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    if (shouldAnimate && !isUser) {
      setDisplayedContent('');
      setIsTyping(true);
      let index = 0;
      
      timeout = setTimeout(() => {
        interval = setInterval(() => {
          if (index < finalCleanText.length) {
            setDisplayedContent(finalCleanText.slice(0, index + 1));
            index++;
          } else {
            setIsTyping(false);
            if (interval) clearInterval(interval);
          }
        }, 10);
      }, 50);

    } else {
      setDisplayedContent(finalCleanText);
      setIsTyping(false);
    }

    return () => {
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };
  }, [finalCleanText, shouldAnimate, isUser]);


  // --- HANDLERS Y FETCHING ---
  
  const fetchOdbOptionsForZone = async (zone: string) => {
    const trimmed = zone.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`${API_BASE}/smartolt/zones/${encodeURIComponent(trimmed)}/odbs`, { credentials: 'include', cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data?.odbs)) {
        const odbMap: Record<string, string> = {};
        const options = data.odbs.map((o: OdbApiResponseItem) => {
            if (o?.name && o?.externalId) odbMap[o.name] = String(o.externalId);
            return o?.name || (o?.id ? String(o.id) : '');
          }).filter(Boolean).map(String);
        setDynamicOptions((prev) => ({ ...prev, 'auth-odb': options }));
        setOdbNameToExternalId(odbMap);
      }
    } catch (err) { console.error(err); }
  };

  const fetchPortsForOdb = async (odbNameOrId: string) => {
    const externalId = odbNameToExternalId[odbNameOrId] || odbNameOrId;
    if (!externalId) return;
    try {
      const res = await fetch(`${API_BASE}/odb/odbs/${encodeURIComponent(externalId)}/ports`, { credentials: 'include', cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data?.ports)) {
        const portOptions = data.ports.map((p: PortApiResponseItem) => 
          typeof p === 'object' ? String(p.port) : String(p)
        );
        setDynamicOptions((prev) => ({ ...prev, 'auth-odb-port': portOptions }));
      }
    } catch (err) { console.error(err); }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) { console.error(err); }
  };

  const downloadImage = (url: string) => {
    const fullUrl = resolveImageUrl(url);
    if(!fullUrl) return;
    const link = document.createElement('a');
    link.href = fullUrl;
    link.download = `smartolt-evidencia-${Date.now()}.png`;
    link.click();
  };

  const resolvePayload = (actionPayload?: string, value?: string) => {
    let payload = actionPayload || value || '';
    if (!payload) return '';

    if (payload.includes('{input}') && value) {
      payload = payload.replace('{input}', value);
    }

    if (payload.includes('{')) {
      Object.entries(inputValues).forEach(([key, val]) => {
        if (!key) return;
        payload = payload.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val ?? ''));
      });
    }

    return payload;
  };

  const handleOnuSelect = (onu: OnuEntry, olt: OltEntry) => {
    setSelectedOnu({ oltId: olt.oltId, board: onu.board, port: onu.port, ponType: onu.ponType, onuId: onu.id });
    if (onu.actionPayload) onActionSelect?.(onu.actionPayload);
  };

  const safeActions = useMemo(() => (Array.isArray(actions) ? actions.filter((a) => a?.type) : []), [actions]);
  
  const inputActions = useMemo(() => {
    const rawInputs = safeActions.filter((a) => a.type === 'input');
    const hasSpeedPrev = !!inputValues['auth-speed'] || !!inputValues['auth-download'] || !!inputValues['auth-upload'];
    
    const filtered = rawInputs.filter((a) => {
        if (HIDDEN_FIELDS.includes(a.id)) return false;
        if (selectedOnu && ["auth-olt_id", "auth-board", "auth-port"].includes(a.id)) return false;
        return !["auth-download", "auth-upload"].includes(a.id);
    }).map(a => ({ ...a, options: dynamicOptions[a.id] || a.options }));

    if ((rawInputs.some(a => ['auth-download', 'auth-upload'].includes(a.id)) || hasSpeedPrev) && !filtered.some(a => a.id === 'auth-speed')) {
      filtered.push({
        id: 'auth-speed', label: 'Velocidad (M)', placeholder: 'Ej: 300M',
        options: ['200M', '400M', '600M', '800M'], helperText: 'Velocidad simétrica', type: 'input'
      });
    }
    return filtered;
  }, [safeActions, selectedOnu, dynamicOptions, inputValues]);

  const buttonActions = safeActions
    .filter((a) => a.type === 'button' || a.type === 'link')
    .filter((a) => {
      if (hasSmartoltTable) {
        if (a.id.includes('select-onu') || (a.payload || '').toLowerCase().includes('seleccionar onu')) {
          return false;
        }
      }
      return true;
    });

  const submitAction = buttonActions.find((a) => a.id === 'auth-submit' || a.id === 'wan-apply' || a.id === 'wifi_submit' || a.id === 'change-onu-submit');
  
  const selectionButtonsToRender = buttonActions.filter((a) => {
    const isSelection = a.id.startsWith('select') || (a.payload || '').toLowerCase().includes('seleccionar');
    if (!isSelection) return false;
    if (hasInstallationsTable && (a.id.startsWith('select-installation-') || installations.some(i => i.actionPayload === a.payload))) return false;
    if (hasInstallationsTable && hasClientSelectActions && ((a.payload || '').toLowerCase().includes('seleccionar cliente') || a.id.startsWith('select-client-'))) return false;
    return true;
  });

  const selectionIds = new Set(selectionButtonsToRender.map(a => a.id));
  const otherButtons = buttonActions.filter(a => a.id !== submitAction?.id && !selectionIds.has(a.id) && !a.id.startsWith('select-installation-'))
    .filter(a => !(hasInstallationsTable && hasClientSelectActions && (a.id.startsWith('select-client-') || (a.payload || '').toLowerCase().includes('seleccionar cliente'))));
  
const handleBulkSubmit = async () => {
  if (disableActionButtons) return;
  setIsSubmitting(true);

  try {
    // 1. Identificar el tipo de acción
    const isWanFlow = submitAction?.id === 'wan-apply';
    const isWifiFlow = submitAction?.id === 'wifi_submit'; 
    const isAuth = submitAction?.id === 'auth-submit';
    const isChangeOnuFlow = submitAction?.id === 'change-onu-submit';

    // 2. Validación específica para WiFi (antes de procesar nada)
    if (isWifiFlow) {
      const pass = inputValues['wifi_pass'] || '';
      // Regex: Mínimo 8 caracteres, al menos 1 mayúscula y 1 número
      const passRegex = /^(?=.*[A-Z])(?=.*\d).{8,}$/;
      if (!passRegex.test(pass)) {
        setWifiError("La contraseña debe tener mín. 8 caracteres, 1 mayúscula y 1 número.");
        return; // Detener ejecución si la validación falla
      }
      setWifiError(null);
    }

    // 3. Preparación del Modal para flujo de Autorización
    if (isAuth) {
      setIsProcessing(true);
      // Estado inicial: El primero "cargando", los demás "pendientes"
      setProcessSteps([
        { id: 'auth', label: 'Validando en SmartOLT', status: 'loading' },
        { id: 'wan', label: 'Provisionando servicio WAN', status: 'pending' },
        { id: 'geonet', label: 'Registrando en Geonet/WispHub', status: 'pending' }
      ]);
    }

    // 4. Recolección de Datos (Inputs + ONU Seleccionada)
    const collected: Record<string, string> = {};
    let speedValue = '';

    // Asegurarnos de incluir 'auth-speed' en la recolección si existe en los inputs dinámicos
    const allInputActions = [...safeActions];
    if (inputActions.some(a => a.id === 'auth-speed') && !allInputActions.find(a => a.id === 'auth-speed')) {
        allInputActions.push({ id: 'auth-speed', label: 'Speed', type: 'input' });
    }

    for (const action of allInputActions) {
      if (action.type !== 'input') continue;

      const val = (inputValues[action.id] || action.placeholder || '').toString().trim();
      
      // Ignorar campos vacíos que no sean estrictamente necesarios (excepto SN o Wifi)
      if (!val && action.id !== 'auth-sn' && !action.id.startsWith('wifi_') && !HIDDEN_FIELDS.includes(action.id)) continue;
      
      // Normalizar velocidad si es necesario
      if (action.id === 'auth-speed') { 
        speedValue = normalizeSpeedProfile(val); 
        continue; 
      }

      // Limpiar prefijos de las claves (auth- o wan-)
      const key = action.id.startsWith('wifi_') ? action.id : action.id.replace(/^auth-|^wan-/, '');
      collected[key] = val;
    }

    // Asignar perfiles de velocidad si se detectaron
    if (speedValue) {
      collected['download_speed_profile_name'] = speedValue;
      collected['upload_speed_profile_name'] = speedValue;
    }

    // Fusionar con los datos de la ONU seleccionada (Board, Port, SN, etc.)
    if (selectedOnu) {
      Object.assign(collected, selectedOnu);
    }

    // Preparar payload para acciones genéricas (reemplazo de variables como {ssid}).
    // Aplicar el mismo reemplazo de placeholders para el flujo de cambio de ONU.
    let finalPayload = submitAction?.payload || '';
    if ((isWifiFlow || isChangeOnuFlow) && finalPayload) {
      Object.keys(collected).forEach((key) => {
        finalPayload = finalPayload.replace(new RegExp(`{${key}}`, 'g'), collected[key]);
      });
    }

    // 5. Ejecución de la Promesa (Try / Catch)
    try {
      if (isAuth) {
        // A) FLUJO DE AUTORIZACIÓN (CON MODAL)
        
        // PASO CRÍTICO: Esperar a que el backend termine el proceso real.
        // El modal se queda en estado "loading" en el primer paso mientras esto ocurre.
        await onSubmitAuth?.(collected);
        
        // --- ZONA DE ÉXITO ---
        // Si la línea de arriba no lanza error, procedemos a mostrar los ticks verdes secuencialmente.
        
        // 1. Marcar Auth como completado
        setProcessSteps(prev => prev.map(s => s.id === 'auth' ? { ...s, status: 'complete' } : s));
        await new Promise(r => setTimeout(r, 300)); // Pausa visual
        
        // 2. Marcar Wan como completado (simulación visual de pasos rápidos)
        setProcessSteps(prev => prev.map(s => s.id === 'wan' ? { ...s, status: 'complete' } : s));
        await new Promise(r => setTimeout(r, 300)); 
        
        // 3. Marcar Geonet como completado
        setProcessSteps(prev => prev.map(s => ({ ...s, status: 'complete' })));
        await new Promise(r => setTimeout(r, 600)); // Pausa final para ver todo verde
        
        // Cerrar modal
        setIsProcessing(false);

      } 
      else if (isChangeOnuFlow) {
        if (onSubmitAction) await onSubmitAction(finalPayload, collected);
        else if (onActionSelect) onActionSelect(finalPayload);
      }
      else if (isWifiFlow) {
        // B) FLUJO WIFI
        if (onSubmitAction) await onSubmitAction(finalPayload, collected);
        else if (onActionSelect) onActionSelect(finalPayload);
      } 
      else if (isWanFlow) {
        // C) FLUJO WAN
        await onSubmitWan?.(collected);
      } 
      else {
        // D) DEFAULT
        await onSubmitAuth?.(collected);
      }

    } catch (e) {
      console.error("Error en submit:", e);

      // --- ZONA DE ERROR (SOLO PARA AUTH) ---
      if (isAuth) {
        // Buscamos cuál paso se quedó cargando y lo marcamos como ERROR (X Roja)
        setProcessSteps(prev => prev.map(s => 
          s.status === 'loading' ? { ...s, status: 'error' } : s
        ));

        // Importante: Esperamos 2.5 segundos manteniendo el modal abierto
        // para que el usuario pueda ver la X roja y leer "Falló la operación".
        await new Promise(r => setTimeout(r, 2500));
        
        setIsProcessing(false);
      }
      // Nota: Para otros flujos (Wifi/Wan) podrías poner un toast de error aquí si quisieras.
    }
    } finally {
      setIsSubmitting(false);
    }
  };
  const hasVersions = versions && versions.length > 1;
  const currentIdx = currentVersion ?? 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${highlighted ? 'bg-neutral-900/40' : ''} px-2 sm:px-3 py-2`}>
      <div className="w-full max-w-4xl flex gap-2 sm:gap-3 items-start">
        {!isUser && (
          <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-400/30 text-emerald-400" aria-label="Bot">
            <Bot className="size-4" />
          </div>
        )}
        
        <div className="flex-1 group min-w-0">
          {isUser ? (
            <div className="flex flex-col items-end">
              <div className="text-xs text-neutral-500 mb-1.5 mr-1 font-medium">{authUser?.username || 'Tú'}</div>
              <div className="inline-block max-w-[98%] sm:max-w-[85%] bg-neutral-800 text-neutral-50 px-3.5 sm:px-4 py-2.5 rounded-2xl border border-neutral-700/60 text-[15px] whitespace-pre-wrap shadow-sm">
                {displayedContent}
                
                {imageDataUrl && (
                  <div className="mt-3 relative group/img overflow-hidden rounded-xl border border-neutral-700 max-w-full sm:max-w-xs">
                    <ImagePreview 
                      src={imageDataUrl}
                      alt="Enviada"
                      onClick={() => setIsZoomed(true)}
                      className="max-h-64 w-full object-cover cursor-pointer"
                    />
                  </div>
                )}
              </div>
              {createdAt && <div className="mt-1 mr-2 text-[10px] text-neutral-500">{new Date(createdAt).toLocaleTimeString()}</div>}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-neutral-50 text-sm sm:text-[15px] leading-[1.8] whitespace-pre-wrap break-words">
                {displayedContent}
                {isTyping && <span className="inline-block w-1.5 h-4 align-middle bg-emerald-400 ml-1 animate-pulse rounded-sm" />}
                
                {imageDataUrl && (
                  <div className="mt-4 relative group/img w-full max-w-sm sm:max-w-md">
                    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 shadow-xl transition-all hover:border-emerald-500/50 overflow-hidden">
                       <ImagePreview 
                         src={imageDataUrl}
                         alt="Evidencia técnica"
                         onClick={() => setIsZoomed(true)}
                         onDownload={() => downloadImage(imageDataUrl)}
                         className="h-auto max-h-[350px] object-cover"
                       />
                    </div>
                  </div>
                )}
              </div>

              {/* --- TABLA INSTALACIONES (RESPONSIVE) --- */}
              {hasInstallationsTable && (
                <div className="mt-4 w-full flex flex-col items-start md:items-stretch px-1 sm:px-0">
                  <div className="w-full md:max-w-none space-y-3">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500 font-semibold">
                      <span className="h-2 w-2 rounded-full bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.15)]" />
                      {hasClientSelectActions ? 'Clientes encontrados' : 'Instalaciones Pendientes'}
                    </div>
                    <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 overflow-hidden shadow-sm">
                      <div className="hidden md:grid grid-cols-12 px-4 py-2.5 text-[11px] uppercase text-neutral-500 border-b border-neutral-800/70 bg-neutral-950/30">
                        <div className="col-span-1">ID</div>
                        <div className="col-span-4">Cliente</div>
                        <div className="col-span-5">Dirección</div>
                        <div className="col-span-2 text-right">Acción</div>
                      </div>
                      
                      <div className="divide-y divide-neutral-800/60">
                        {installations.map((inst) => (
                          <div key={inst.id} className="flex flex-col md:grid md:grid-cols-12 md:items-center px-3 sm:px-4 py-4 md:py-3 gap-3 md:gap-2 text-sm text-neutral-100 hover:bg-neutral-800/40 transition-colors">
                            <div className="flex justify-between items-center md:hidden pb-2 border-b border-neutral-800/50">
                               <span className="text-xs font-mono text-neutral-500">#{inst.id}</span>
                               <span className="text-[10px] text-neutral-500 uppercase font-medium">Instalación</span>
                            </div>
                            <div className="md:col-span-1 font-mono text-xs text-neutral-500 hidden md:block">{inst.id}</div>
                            <div className="md:col-span-4 font-medium flex flex-col">
                              <span className="md:hidden text-[10px] text-neutral-500 uppercase mb-0.5">Cliente</span>
                              <span title={inst.clientName} className="break-words">{inst.clientName}</span>
                            </div>
                            <div className="md:col-span-5 text-xs text-neutral-400 flex flex-col md:flex-row md:items-center gap-1.5">
                              <span className="md:hidden text-[10px] text-neutral-500 uppercase mt-2 mb-0.5">Dirección</span>
                              <div className="flex items-start gap-1.5">
                                <MapPin className="size-3.5 shrink-0 mt-0.5 md:mt-0" /> 
                                <span className="break-words">{inst.address}</span>
                              </div>
                            </div>
                            <div className="md:col-span-2 md:text-right mt-2 md:mt-0">
                              <Button 
                                size="sm" 
                                onClick={() => inst.actionPayload && onActionSelect?.(inst.actionPayload)} 
                                disabled={disableActionButtons}
                                className="w-full md:w-auto h-9 md:h-7 text-xs font-medium bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg"
                              >
                                {(inst.actionPayload || '').toLowerCase().includes('seleccionar cliente') ? 'Seleccionar' : 'Autorizar'}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* --- TABLA SMARTOLT (RESPONSIVE) --- */}
              {hasSmartoltTable && (
                <div className="mt-4 w-full flex flex-col items-start md:items-stretch px-1 sm:px-0">
                  <div className="w-full md:max-w-none space-y-4">
                     <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500 font-semibold">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" /> Disponibilidad SmartOLT
                    </div>
                    {smartoltAvailability?.olts?.map((olt) => (
                      <div key={olt.oltId} className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4 shadow-sm">
                         <div className="flex flex-wrap justify-between items-center mb-4 gap-2">
                          <div className="flex items-center gap-2">
                             <Server className="size-4 text-emerald-600"/>
                             <div className="text-sm font-bold text-emerald-500 uppercase tracking-wider">
                               {olt.oltName || 'OLT'}
                             </div>
                          </div>
                          <span className="text-[10px] bg-neutral-800 text-neutral-400 px-2.5 py-1 rounded-full border border-neutral-700/50">
                            {olt.onus.length} ONUs
                          </span>
                        </div>
                        <div className="overflow-hidden rounded-lg border border-neutral-800/70 bg-black/20">
                          <div className="hidden md:grid grid-cols-12 gap-2 px-4 py-2 bg-neutral-800/50 text-[11px] font-bold text-neutral-500 uppercase">
                            <div className="col-span-2">SN / Label</div>
                            <div className="col-span-1">Tipo</div>
                            <div className="col-span-2 text-center">Board/Port/Pon</div>
                            <div className="col-span-4">Descripción</div>
                            <div className="col-span-2 text-center">Modelo</div>
                            <div className="col-span-1 text-right">Acción</div>
                          </div>
                          <div className="divide-y divide-neutral-800">
                            {olt.onus.map((onu) => (
                              <div key={onu.id} className="flex flex-col md:grid md:grid-cols-12 md:items-center gap-3 md:gap-2 px-3 sm:px-4 py-4 md:py-3 text-[13px] hover:bg-neutral-800/30 transition-colors">
                                 <div className="col-span-12 md:col-span-2 flex flex-row md:flex-col justify-between items-start md:justify-center">
                                  <div className="flex flex-col">
                                      <span className="font-medium text-neutral-200 truncate">{onu.label}</span>
                                      <span className="text-[11px] font-mono text-neutral-500 uppercase bg-neutral-900/50 px-1 rounded w-fit mt-0.5">{onu.sn || 'Sin SN'}</span>
                                  </div>
                                  <span className="md:hidden px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 text-[10px] font-bold border border-blue-500/20">
                                    {onu.ponType || 'GPON'}
                                  </span>
                                </div>
                                <div className="hidden md:block col-span-4 md:col-span-1">
                                  <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 text-[10px] font-bold border border-blue-500/20">
                                    {onu.ponType || 'GPON'}
                                  </span>
                                </div>
                                <div className="col-span-4 md:col-span-2 flex items-center md:justify-center gap-2 text-neutral-300">
                                  <Network className="size-3.5 md:hidden text-neutral-500" />
                                  <span className="md:hidden text-neutral-500 text-xs">Puerto:</span>
                                  <span className="font-mono bg-neutral-800/40 px-1.5 py-0.5 rounded">{onu.board}/{onu.port}/{onu.ponPort}</span>
                                </div>
                                <div className="col-span-12 md:col-span-4 text-xs text-neutral-400 italic truncate flex items-center gap-2">
                                  <span className="md:hidden not-italic font-semibold text-neutral-500">Desc:</span>
                                  {onu.description || 'Sin descripción'}
                                </div>
                                <div className="col-span-4 md:col-span-2 md:text-center text-neutral-400 flex items-center md:justify-center gap-2">
                                  <HardDrive className="size-3.5 md:hidden text-neutral-500" />
                                  <span className="md:hidden text-neutral-500 text-xs">Modelo:</span>
                                  {onu.type || onu.model || 'N/A'}
                                </div>
                                <div className="col-span-12 md:col-span-1 text-right mt-1 md:mt-0">
                                  <Button 
                                    size="sm" 
                                    onClick={() => handleOnuSelect(onu, olt)} 
                                    disabled={disableActionButtons}
                                    className="w-full md:w-auto h-10 md:h-8 px-4 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white border-none shadow-lg shadow-emerald-900/20 rounded-lg active:scale-95 transition-transform"
                                  >
                                    Usar
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* --- BOTONES Y ACCIONES --- */}
                <div className="mt-2 space-y-4 px-1 sm:px-0">
                {selectionButtonsToRender.length > 0 && (
                  <div className="w-full flex justify-start">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full md:max-w-none">
                      {selectionButtonsToRender.map(a => (
                        <Button key={a.id} size="sm" disabled={disableActionButtons} onClick={() => onActionSelect?.(resolvePayload(a.payload, a.label))} className="h-10 bg-neutral-100 text-neutral-900 hover:bg-white truncate border border-transparent hover:border-neutral-300 transition-all font-medium">
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                
                {otherButtons.length > 0 && (
                  <div className="w-full flex justify-start">
                    <div className="flex flex-wrap gap-2 w-full md:max-w-none justify-start">
                      {otherButtons.map(a => {
                         if (a.type === 'link' && a.url) {
                          const href = a.url.startsWith('http') ? a.url : `${API_BASE}${a.url}`;
                          if (disableActionButtons) {
                            return (
                              <span
                                key={a.id}
                                className="inline-flex items-center justify-center rounded-lg text-sm font-medium h-9 bg-neutral-900 text-neutral-600 px-4 border border-neutral-800 cursor-not-allowed select-none"
                                aria-disabled="true"
                              >
                                {a.label}
                              </span>
                            );
                          }
                          return (
                            <a 
                              key={a.id} href={href} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center justify-center rounded-lg text-sm font-medium h-9 bg-neutral-800 text-neutral-300 hover:bg-neutral-700 px-4 hover:text-white transition-colors no-underline border border-neutral-700"
                            >
                              {a.label}
                            </a>
                          );
                        }
                        return (
                          <Button key={a.id} size="sm" disabled={disableActionButtons} onClick={() => onActionSelect?.(resolvePayload(a.payload, a.label))} className="h-9 bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white border border-neutral-700">
                            {a.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {inputActions.length > 0 && (
                  <div className="w-full flex justify-start">
                    <div className="space-y-4 bg-neutral-900/60 p-4 sm:p-5 rounded-2xl border border-neutral-800/80 shadow-inner ring-1 ring-neutral-800/50 w-full md:max-w-none">
                      {inputActions.map(action => {
                        // Determinar si es Read-Only
                        const isReadOnly = READ_ONLY_FIELDS.includes(action.id);
                        
                        return (
                          <div key={action.id} className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="text-xs text-neutral-400 font-medium ml-1">{action.label}</div>
                              {isReadOnly && <Lock className="size-3 text-neutral-600" />}
                            </div>
                            
                            {action.options?.length ? (
                              <SearchableSelect 
                                action={action} 
                                value={inputValues[action.id] || ''} 
                                disabled={isReadOnly || action.disabled}
                                onChange={(val) => {
                                  setInputValues(p => ({ ...p, [action.id]: val }));
                                  if (action.id === 'auth-zone') fetchOdbOptionsForZone(val);
                                  if (action.id === 'auth-odb') fetchPortsForOdb(val);
                                }} 
                              />
                            ) : (
                              <div className="relative">
                                <Input 
                                  value={inputValues[action.id] || ''} 
                                  type={action.id === 'wifi_pass' && !showWifiPass ? 'password' : 'text'}
                                  readOnly={isReadOnly}
                                  disabled={isReadOnly || action.disabled}
                                  onChange={(e) => {
                                    setInputValues(p => ({ ...p, [action.id]: e.target.value }));
                                    if (action.id === 'wifi_pass') setWifiError(null);
                                  }} 
                                  placeholder={action.placeholder} 
                                  className={`h-10 bg-neutral-950/80 border-neutral-800 focus:border-emerald-500/60 focus-visible:ring-2 focus-visible:ring-emerald-500/20 ${action.id === 'wifi_pass' ? 'pr-10' : ''} ${action.id === 'wifi_pass' && wifiError ? 'border-red-500 focus-visible:ring-red-500/30' : ''} ${isReadOnly ? 'opacity-60 cursor-not-allowed bg-neutral-900 text-neutral-400 select-none' : ''}`} 
                                />
                                
                                {action.id === 'wifi_pass' && (
                                  <button
                                    type="button"
                                    onClick={() => setShowWifiPass(!showWifiPass)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors focus:outline-none"
                                    tabIndex={-1}
                                  >
                                    {showWifiPass ? (
                                      <EyeOff className="size-4" />
                                    ) : (
                                      <Eye className="size-4" />
                                    )}
                                  </button>
                                )}

                                {action.helperText && !wifiError && <div className="text-[10px] text-neutral-600 mt-1 ml-1">{action.helperText}</div>}
                              </div>
                            )}
                            {action.id === 'wifi_pass' && wifiError && (
                              <span className="text-[10px] text-red-500 mt-1 block animate-in slide-in-from-top-1 ml-1">{wifiError}</span>
                            )}
                          </div>
                        );
                      })}
                      {submitAction && (
                        <Button 
                          className={`w-full h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold mt-2 shadow-lg shadow-emerald-900/20 transition-all ${submitAction.id === 'wifi_submit' && wifiError ? 'opacity-50 cursor-not-allowed' : ''}`}
                          onClick={handleBulkSubmit}
                          disabled={disableActionButtons || (submitAction.id === 'wifi_submit' && !!wifiError)}
                        >
                          {submitAction.label}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* FOOTER */}
              <div className="flex items-center gap-3 mt-4 flex-wrap">
                {hasVersions && (
                  <div className="flex items-center gap-1 bg-neutral-800/50 rounded-lg px-1.5 py-1 border border-neutral-800">
                    <Button variant="ghost" size="sm" onClick={() => onVersionChange?.(messageId, 'prev')} disabled={currentIdx === 0} className="h-6 w-6 p-0 hover:bg-neutral-700/50"><ChevronLeft className="size-3.5" /></Button>
                    <span className="text-[10px] text-neutral-400 font-mono w-6 text-center">{currentIdx + 1}/{versions.length}</span>
                    <Button variant="ghost" size="sm" onClick={() => onVersionChange?.(messageId, 'next')} disabled={currentIdx === versions.length - 1} className="h-6 w-6 p-0 hover:bg-neutral-700/50"><ChevronRight className="size-3.5" /></Button>
                  </div>
                )}
                
                <div className="flex items-center gap-1.5 transition-opacity">
                  <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 px-2 text-neutral-500 hover:text-white hover:bg-neutral-800 text-[11px]">
                    {copied ? <Check className="size-3 mr-1.5 text-emerald-400" /> : <Copy className="size-3 mr-1.5" />}
                    {copied ? 'Copiado' : 'Copiar'}
                  </Button>
                  {isLatest && onRetry && (
                    <Button variant="ghost" size="sm" onClick={onRetry} className="h-7 px-2 text-neutral-500 hover:text-white hover:bg-neutral-800 text-[11px]">
                      <RotateCcw className="size-3 mr-1.5" /> Reintentar
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* --- MODAL PROCESAMIENTO --- */}
      <ProcessingModal isOpen={isProcessing} steps={processSteps} />

      {/* --- MODAL ZOOM --- */}
      {isZoomed && imageDataUrl && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-4 animate-in fade-in duration-200 backdrop-blur-sm"
          onClick={() => setIsZoomed(false)}
        >
          <Button 
            className="absolute top-4 right-4 rounded-full bg-neutral-800 hover:bg-neutral-700 text-white z-[101] size-10 border border-neutral-700"
            size="icon"
            onClick={(e) => { e.stopPropagation(); setIsZoomed(false); }}
          >
            <X className="size-5" />
          </Button>
          
          <img 
            src={resolveImageUrl(imageDataUrl) || imageDataUrl} 
            className="max-w-full max-h-[85vh] w-auto h-auto object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
            alt="Zoom"
            onClick={(e) => e.stopPropagation()} 
          />
          
          <div className="absolute bottom-8 flex gap-4 z-[101]">
            <Button 
              onClick={(e) => { e.stopPropagation(); downloadImage(imageDataUrl); }}
              className="bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/50"
            >
              <Download className="size-4 mr-2" /> Descargar Original
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
