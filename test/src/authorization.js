export const userPart = (jid) => jid.split('@')[0].split(':')[0];

export function isOwnerMessage(fromMe, sender, owners) {
  return fromMe || owners.some((owner) => userPart(owner) === userPart(sender));
}