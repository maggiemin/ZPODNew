namespace com.riotinto.s4.v;

entity ZCLPODReasonCodes {
    key code        : String(4);
        description : String(40);
}

entity ZCLPODStatusCodes {
    key code        : String(1);
        description : String(25);
}

entity ZCLDeliveryHeaders {
    key deliveryDocument     : String(10);
        salesOrganization    : String(4);
        deliveryDate         : Date;
        documentDate         : Date;
        shipToParty          : String(10);
        shipToPartyName      : String(80);
        shippingPoint        : String(4);
        overallPodStatus              : String(1);
        podStatusCriticality          : Integer;
        podDate                       : Date;
        podTime                       : Time;
        actualGoodsMvmtDate           : Date;
        goodsMovementStatus           : String(1);
        goodsMovementStatusCriticality: Integer;
        goodsMovementStatusText       : String(25);
        overallPodStatusText          : String(25);
        deliveryItems        : Composition of many ZCLDeliveryItems
                               on deliveryItems.deliveryDocument = deliveryDocument;
}

entity ZCLDeliveryItems {
    key deliveryDocument       : String(10);
    key deliveryDocumentItem   : String(6);
        salesOrder             : String(10);
        material               : String(40);
        itemText               : String(40);
        actualDeliveryQuantity : Decimal(13,3);
        deliveryQuantityUnit   : String(3);
        podRelevanceCode       : String(1);
        podStatus              : String(1);
        goodsMovementStatus    : String(1);
        actualGoodsMvmtDate    : Date;
        podQuantity            : Decimal(13,3);
        podQuantityUnit        : String(3);
        podReasonCode          : String(4);
        qtyDiffnSalesUn        : Decimal(13,3);
}
