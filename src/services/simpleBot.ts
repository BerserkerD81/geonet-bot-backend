export type SuggestedAction = {
  id: string;
  type: 'button' | 'input';
  label: string;
  payload?: string;
  placeholder?: string;
  helperText?: string;
};

export function getMockResponse(userMessage: string): string {
  const lowerMessage = userMessage.toLowerCase();

  if (lowerMessage.includes('alta') || lowerMessage.includes('nuevo cliente') || lowerMessage.includes('instalación')) {
    return `Asistente SmartOLT - Alta de cliente:\n\nPuedo ayudarte a validar que la instalación está lista para ser autorizada. Normalmente revisamos:\n\n1) Datos del cliente completos (nombre, documento, dirección)\n2) ONT registrada con número de serie correcto\n3) Puerto de OLT disponible y sin alarmas\n4) Potencia óptica dentro de rango\n5) Evidencias subidas (fotos de acometida, ONT y etiqueta)\n\nCuéntame qué ya tienes cargado y qué te falta, y te guío paso a paso.`;
  }

  if (lowerMessage.includes('ont') || lowerMessage.includes('olt') || lowerMessage.includes('potencia')) {
    return `Asistente SmartOLT - Estado de ONT/OLT:\n\nDe forma típica, para revisar un cliente en SmartOLT debes comprobar:\n\n- Estado de la ONT (online/offline)\n- Potencia RX de la ONT\n- Puerto PON y posición del cliente\n- Alarmas activas en el puerto o en la ONT\n\nSi me indicas el ID de cliente, la OLT o el número de serie de la ONT, te puedo sugerir los pasos de diagnóstico que suele seguir el NOC.`;
  }

  if (lowerMessage.includes('revisar') || lowerMessage.includes('validar') || lowerMessage.includes('checklist')) {
    return `Asistente SmartOLT - Checklist de instalación:\n\nAquí tienes un checklist típico que usan los instaladores antes de autorizar el alta:\n\n- ONT energizada y con luz PON fija\n- Potencia óptica medida y dentro de rango\n- Conectores limpios y sin dobleces críticos en la fibra\n- Serie de ONT registrada en SmartOLT\n- Fotos de la instalación y del ONT subidas al sistema\n\nPuedes usar este checklist y marcar cada punto mientras haces la instalación.`;
  }

  return `Soy tu asistente para SmartOLT y la autogestión de instalaciones.\n\nPuedo ayudarte con:\n- Altas de nuevos clientes FTTH\n- Revisión de estado de ONT y puertos de OLT\n- Validación de instalaciones antes de autorizar el servicio\n- Listas de verificación para técnicos instaladores\n\nDime qué estás haciendo (alta nueva, visita técnica, verificación de señal, etc.) y te guío paso a paso.`;
}

export function getSuggestedActions(userMessage: string): SuggestedAction[] {
  const lower = userMessage.toLowerCase();

  const wisphubActions: SuggestedAction[] = [
    {
      id: 'wisphub-instalaciones-pendientes',
      type: 'button',
      label: 'Listar instalaciones pendientes.',
      payload: 'Ver instalaciones pendientes en WispHub',
    },
  ];

  const smartoltActions: SuggestedAction[] = [
    {
      id: 'smartolt-checklist',
      type: 'button',
      label: 'Checklist de instalación FTTH',
      payload: 'Mostrar checklist de instalación FTTH en SmartOLT',
    },
    
  ];

  const actions: SuggestedAction[] = [];

  if (lower.includes('wisphub') || lower.includes('wisp') || lower.includes('cliente')) {
    actions.push(...wisphubActions);
  }

  if (lower.includes('smartolt') || lower.includes('olt') || lower.includes('ont')) {
    actions.push(...smartoltActions);
  }

  if (actions.length === 0) {
    actions.push(
      wisphubActions[0],
      wisphubActions[1],
      smartoltActions[0],
      smartoltActions[1],
    );
  }

  return actions;
}

export function buildStructuredResponse(userMessage: string): { content: string; actions: SuggestedAction[] } {
  const content = getMockResponse(userMessage);
  const actions = getSuggestedActions(userMessage);
  return { content, actions };
}
